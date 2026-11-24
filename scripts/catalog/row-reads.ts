/**
 * The reads the row checker makes: for an Ollama row a manifest and one small config blob, for a Hugging Face repo the API
 * record and `config.json`, and nothing larger. Each function asks one registry the way registry-endpoints.ts says and
 * hands back parsed data. What the data means is row-checks.ts's job.
 *
 * Read-only by construction: every request is a GET, and a body longer than MAX_BODY_BYTES is refused unread, so a URL
 * that ever resolved to a weights blob would be an error here instead of a multi-gigabyte download.
 *
 * An answer is either definitive (the registry said 200, 400, 401 or 404: a {@link Read}) or it is no answer: a network
 * error, a timeout, or a 429 or 5xx that outlasted the retries. The second throws {@link ReadFailed}, so that a row the
 * script could not read is reported as unread and never passes for a row that was read and found fine.
 */
import {
  type HfGgufRef,
  hfManifestUrl,
  MANIFEST_ACCEPT,
  OLLAMA_UA,
  type OllamaRef,
  ollamaBlobUrl,
  ollamaManifestUrl,
  UA,
} from './registry-endpoints';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReadDeps {
  fetch: Fetcher;
  sleep: (ms: number) => Promise<void>;
}

/** The registry gave no answer: network, timeout, 429 or 5xx after the retries, or a body that is not what it should be. */
export class ReadFailed extends Error {}

/** A definitive answer: the value, or the HTTP status and the registry's own words for refusing. */
export type Read<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

export interface OllamaManifest {
  config?: { digest?: string };
  layers?: { mediaType?: string; digest?: string; size?: number }[];
}

/** The fields of a model's config blob that the checker reads. */
export interface OllamaConfig {
  file_type?: string;
  requires?: string;
  remote_host?: string;
  remote_model?: string;
}

export interface HfModel {
  sha?: string;
  gated?: boolean | string;
  private?: boolean;
  disabled?: boolean;
  siblings?: { rfilename?: string; size?: number }[];
}

export interface HfRepoRead {
  model: HfModel;
  /** `config.json` at the commit the file list came from. Absent when the repo has none, or fails (gated, private) before it matters. */
  config?: Record<string, unknown>;
  /** What the request for `config.json` answered, when it was made and was not 200. */
  configStatus?: number;
}

interface Reply {
  status: number;
  text: string;
  headers: Pick<Headers, 'get'>;
  /** The answer came from another host than the one asked: the registry's redirect to its storage. */
  foreign: boolean;
}

const ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;
/** A rate limit that asks for longer than this is reported as unread rather than waited out. */
const MAX_WAIT_MS = 30_000;
/** The largest body ever read: a manifest, a config blob, or an API record. Weights are gigabytes. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

const isTransient = (status: number): boolean => status === 429 || status >= 500;

/** How long to wait before the next attempt: what the server asks for (`Retry-After`, or Hugging Face's exhausted `ratelimit` window), else 1 s, 2 s, 4 s. */
export function retryDelayMs(headers: Pick<Headers, 'get'>, attempt: number): number {
  const retryAfter = Number(headers.get('retry-after'));
  if (headers.get('retry-after') && Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  const window = headers.get('ratelimit')?.match(/;r=(\d+);t=(\d+)/);
  if (window && Number(window[1]) === 0) return Number(window[2]) * 1000;
  return 1000 * 2 ** attempt;
}

const fromAnotherHost = (res: Response, url: string): boolean => res.url !== '' && new URL(res.url).host !== new URL(url).host;

/** The body as text, stopping with an error as soon as it passes MAX_BODY_BYTES. */
async function boundedText(res: Response, url: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ReadFailed(`refusing a body over ${MAX_BODY_BYTES} bytes from ${url}`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** One GET, retried when the network fails or the server answers 429 or 5xx. A 429 or 5xx that outlasts the retries is returned as it is. */
export async function readReply(url: string, headers: Record<string, string>, deps: ReadDeps): Promise<Reply> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt === ATTEMPTS - 1;
    try {
      const res = await deps.fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const reply: Reply = { status: res.status, text: await boundedText(res, url), headers: res.headers, foreign: fromAnotherHost(res, url) };
      if (!isTransient(reply.status) || last) return reply;
      const wait = retryDelayMs(reply.headers, attempt);
      if (wait > MAX_WAIT_MS) return reply;
      await deps.sleep(wait);
    } catch (err) {
      if (err instanceof ReadFailed) throw err;
      if (last) throw new ReadFailed(`${err instanceof Error ? err.message : String(err)} from ${url} (${ATTEMPTS} attempts)`);
      await deps.sleep(1000 * 2 ** attempt);
    }
  }
}

/** The registry's own words for a refusal: Hugging Face's `error`, Ollama's `errors[0].message`, else the start of the body. */
function refusalMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown; errors?: { message?: unknown }[] };
    const message = typeof body.error === 'string' ? body.error : body.errors?.[0]?.message;
    if (typeof message === 'string') return message.slice(0, 300);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 200).trim();
}

/** The body as a JSON object. An answer that is JSON of another shape (`null`, a list) is as unreadable as one that is not JSON. */
function parseJson<T extends object>(reply: Reply, url: string): T {
  let value: unknown;
  try {
    value = JSON.parse(reply.text);
  } catch {
    throw new ReadFailed(`${url} answered ${reply.status} with a body that is not JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReadFailed(`${url} answered ${reply.status} with JSON that is not an object`);
  }
  return value as T;
}

/**
 * A `config.json` that a Python script wrote. Python's json module writes `NaN`, `Infinity` and `-Infinity` as bare
 * literals, which JSON.parse refuses: mlx-community's Nemotron 3 Nano repo holds `"time_step_limit": [0.0, Infinity]`.
 * Only the first parse failure is worked around, by reading those literals as null; the fields the checker wants are numbers.
 */
function parsePythonJson<T extends object>(reply: Reply, url: string): T {
  try {
    return parseJson<T>(reply, url);
  } catch (err) {
    if (!(err instanceof ReadFailed)) throw err;
    return parseJson<T>({ ...reply, text: reply.text.replace(/(?<![\w"])-?(?:Infinity|NaN)(?![\w"])/g, 'null') }, url);
  }
}

/** A non-200 reply as a definitive refusal, or as no answer when the status is a 429 or a 5xx. */
function refused(reply: Reply, url: string): { ok: false; status: number; message: string } {
  // The registry's own words are printed. A storage host's error page is not: an S3-style error body echoes the signing credential.
  const message = reply.foreign ? '' : refusalMessage(reply.text);
  if (isTransient(reply.status)) throw new ReadFailed(`HTTP ${reply.status} from ${url}${message ? `: ${message}` : ''}`);
  return { ok: false, status: reply.status, message };
}

/** An Ollama registry model: its manifest, and the config blob the manifest names. */
export async function readOllamaRegistry(ref: OllamaRef, deps: ReadDeps): Promise<Read<{ manifest: OllamaManifest; config: OllamaConfig }>> {
  const url = ollamaManifestUrl(ref);
  const reply = await readReply(url, { ...UA, Accept: MANIFEST_ACCEPT }, deps);
  if (reply.status !== 200) return refused(reply, url);
  const manifest = parseJson<OllamaManifest>(reply, url);
  const digest = manifest.config?.digest;
  if (!digest) throw new ReadFailed(`${url} names no config blob`);
  // The registry answers a blob with a redirect to its storage; fetch follows it, and the config is a few hundred bytes.
  const blobUrl = ollamaBlobUrl(ref, digest);
  const blob = await readReply(blobUrl, { ...UA }, deps);
  if (blob.status !== 200) return refused(blob, blobUrl);
  return { ok: true, value: { manifest, config: parseJson<OllamaConfig>(blob, blobUrl) } };
}

/** The manifest Hugging Face serves Ollama for `hf.co/<repo>:<quant>`. It answers HTTP 400 for a repo that holds only sharded GGUF files. */
export async function readHfGgufManifest(ref: HfGgufRef, deps: ReadDeps): Promise<Read<OllamaManifest>> {
  const url = hfManifestUrl(ref);
  const reply = await readReply(url, { 'User-Agent': OLLAMA_UA, Accept: MANIFEST_ACCEPT }, deps);
  if (reply.status !== 200) return refused(reply, url);
  return { ok: true, value: parseJson<OllamaManifest>(reply, url) };
}

const encodeRepo = (repo: string): string => repo.split('/').map(encodeURIComponent).join('/');

/** A Hugging Face repo's API record with file sizes, and its `config.json` at the same commit. */
export async function readHfRepo(repo: string, deps: ReadDeps): Promise<Read<HfRepoRead>> {
  const apiUrl = `https://huggingface.co/api/models/${encodeRepo(repo)}?blobs=true`;
  const api = await readReply(apiUrl, { ...UA }, deps);
  if (api.status !== 200) return refused(api, apiUrl);
  const model = parseJson<HfModel>(api, apiUrl);
  // A gated, private or disabled repo fails the row whatever its config says, and its files would answer 401.
  if (model.gated !== false || model.private || model.disabled) return { ok: true, value: { model } };
  const configUrl = `https://huggingface.co/${encodeRepo(repo)}/resolve/${model.sha ?? 'main'}/config.json`;
  const config = await readReply(configUrl, { ...UA }, deps);
  if (isTransient(config.status)) throw new ReadFailed(`HTTP ${config.status} from ${configUrl}`);
  if (config.status !== 200) return { ok: true, value: { model, configStatus: config.status } };
  return { ok: true, value: { model, config: parsePythonJson<Record<string, unknown>>(config, configUrl) } };
}
