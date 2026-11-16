/**
 * Generates `kv-geometry.generated.ts`: each catalog text model's KV-cache cost per token, read from
 * the GGUF header of the very file its engine serves, for context sizing where nothing better exists.
 *
 * WHY: a model with no measured `kvMbPerToken` was sized by the context ladder's 0.25 MB/token —
 * dense-model arithmetic — wherever the engine could not describe it: every Lemonade row, and an
 * Ollama row before its download. Qwen 3.5 27B keeps a per-token cache in 16 of its 64 layers and costs
 * 0.0625 MB/token, so the picker showed it at 8k on a card that holds 32k at 16-bit. Ollama's own
 * geometry, once downloaded, loses per-layer head counts and counts sliding layers at full size. The
 * geometry is the same in every quantisation and sits at the start of the file, so a range request
 * reads it. Ollama's extra growth beside the cache is `OLLAMA_EXTRA_MB_PER_TOKEN`.
 *
 * Usage (needs network: Hugging Face and registry.ollama.ai):
 *   pnpm exec tsx scripts/catalog/gen-kv-geometry.ts [--lemonade-registry <server_models.json>] [--only <id,id,...>]
 * The Lemonade registry maps a row's backendModelId to its Hugging Face checkpoint; the default is the
 * file a Lemonade install ships (/usr/share/lemonade-server/resources/server_models.json).
 * `--only` reads only the named rows and merges them into the existing file, keeping every other entry
 * byte for byte: use it when rows are added, so the rest of the table is not re-read from registries that
 * may have moved since, and a machine without a Lemonade install (which only Lemonade rows need) can still
 * add Ollama rows. The date in the file's header is the last run's, not each entry's.
 * An `hf.co/` Ollama row is sized from Hugging Face's Ollama manifest, so a vision projector counts as it does
 * for a registry row; a sharded repo, which that endpoint refuses, keeps the size of its files in the tree.
 * Only public model metadata is fetched. Re-run when catalog rows are added.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CURATED_MODELS } from '../../packages/backend/src/modules/inference/catalog/curated-models';
import { isShardedRefusal, type ManifestLayer, resolveHuggingFaceGguf, selectGguf } from './gguf-files';
import { type KvGeometry, kvGeometryFromGguf, NeedMoreBytes, readGgufMetadata } from './gguf-header';
import {
  hfGgufRef,
  hfManifestUrl,
  isHfGguf,
  MANIFEST_ACCEPT,
  OLLAMA_UA,
  ollamaBlobUrl,
  ollamaManifestUrl,
  ollamaRef,
  UA,
} from './registry-endpoints';

const OUT = path.resolve(__dirname, '../../packages/backend/src/modules/inference/catalog/kv-geometry.generated.ts');
const PREFIXES = [1, 4, 16, 64].map((mb) => mb * 1024 * 1024);

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A non-2xx answer, with the start of its body: Hugging Face's endpoint says in the body why it answered 400. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
    readonly body: string,
  ) {
    super(`${status} for ${url}: ${body}`);
  }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { ...UA, ...headers } });
  if (!res.ok) throw new HttpError(res.status, url, (await res.text()).slice(0, 200));
  return res.json();
}

/** The GGUF's metadata, reading a growing prefix until it parses. */
async function readHeader(url: string): Promise<Map<string, unknown>> {
  for (const size of PREFIXES) {
    const res = await fetch(url, { headers: { ...UA, Range: `bytes=0-${size - 1}` } });
    if (!res.ok && res.status !== 206) throw new Error(`${res.status} for ${url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    try {
      return readGgufMetadata(bytes) as Map<string, unknown>;
    } catch (err) {
      if (!(err instanceof NeedMoreBytes) || bytes.byteLength < size) throw err;
    }
  }
  throw new Error(`metadata longer than ${PREFIXES.at(-1)} bytes`);
}

/**
 * A Lemonade row's GGUF on Hugging Face, and the bytes its load maps: the weights (every shard of a
 * split model) plus the vision projector the registry names. The checkpoint is `repo:file.gguf`, or
 * `repo:QUANT` naming a variant in the repo.
 */
async function lemonadeGguf(checkpoint: string, mmproj: string | undefined): Promise<{ url: string; fileBytes: number }> {
  const [repo = '', spec = ''] = checkpoint.split(':');
  const { wanted, fileBytes } = selectGguf(await huggingFaceTree(repo), spec, mmproj);
  return { url: `https://huggingface.co/${repo}/resolve/main/${wanted.path}`, fileBytes };
}

/** Every file in a Hugging Face repo, with its size. */
async function huggingFaceTree(repo: string): Promise<{ path: string; size?: number }[]> {
  const tree = (await getJson(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`)) as {
    path: string;
    type: string;
    size?: number;
  }[];
  return tree.filter((f) => f.type === 'file');
}

/** Every layer Ollama would pull for `hf.co/<repo>:<quant>`, or undefined when Hugging Face serves no manifest for it. */
async function huggingFaceLayers(repo: string, quant: string): Promise<ManifestLayer[] | undefined> {
  try {
    const manifest = (await getJson(hfManifestUrl({ repo, quant }), {
      Accept: MANIFEST_ACCEPT,
      'User-Agent': OLLAMA_UA,
    })) as { layers?: ManifestLayer[] };
    return manifest.layers?.length ? manifest.layers : undefined;
  } catch (err) {
    // A sharded repo answers 400 "sharded GGUF" here, which Ollama cannot pull, so the row is sized from the file tree. Every
    // other refusal must stop the row: a quant the repo does not list, or that is no quantization scheme, answers 400 too (a
    // missing repo is 401), and a 429, a 5xx, or a timeout is no answer. The tree would hand such a row another build's file,
    // sized without its projector.
    if (err instanceof HttpError && isShardedRefusal(err.status, err.body)) return undefined;
    throw err;
  }
}

/**
 * An Ollama row's GGUF in Ollama's registry, and its size: every layer of the manifest. `hf.co/<repo>:<quant>` rows are Hugging Face files,
 * sized by every layer of Hugging Face's manifest (a vision projector is one) or, for a repo that serves none, by its files.
 */
async function ollamaGguf(tagged: string): Promise<{ url: string; fileBytes: number }> {
  if (isHfGguf(tagged)) {
    const { repo, quant } = hfGgufRef(tagged);
    // The header comes from the file picked in the tree, and the pull from the manifest: resolve checks they are one file.
    const { wanted, fileBytes } = resolveHuggingFaceGguf(await huggingFaceTree(repo), tagged, quant, await huggingFaceLayers(repo, quant));
    return { url: `https://huggingface.co/${repo}/resolve/main/${wanted.path}`, fileBytes };
  }
  const ref = ollamaRef(tagged);
  const manifest = (await getJson(ollamaManifestUrl(ref), { Accept: MANIFEST_ACCEPT })) as {
    layers?: { mediaType: string; digest: string; size: number }[];
  };
  const layers = manifest.layers ?? [];
  const model = layers.find((l) => l.mediaType === 'application/vnd.ollama.image.model');
  if (!model) throw new Error(`no model layer for ${tagged}`);
  // Every layer, as `/api/tags` reports a pulled model's size: the load estimate charges that once it is on
  // disk, so the catalog charging the same keeps the two from disagreeing (gemma4 adds a projector and a draft).
  const fileBytes = layers.reduce((sum, l) => sum + l.size, 0);
  return { url: ollamaBlobUrl(ref, model.digest), fileBytes };
}

/** One entry of the generated table, in the exact shape the file carries. */
function formatRow(id: string, r: KvGeometry & { fileBytes: number }): string {
  const swa = r.slidingLayers ? `, slidingKvBytesPerToken: ${r.slidingKvBytesPerToken}, slidingWindow: ${r.slidingWindow}` : '';
  const file = (r.fileBytes > 0 ? `, fileBytes: ${r.fileBytes}` : '') + (r.contextLength ? `, contextLength: ${r.contextLength}` : '');
  return `  ${JSON.stringify(id)}: { architecture: ${JSON.stringify(r.architecture)}, kvBytesPerToken: ${r.kvBytesPerToken}${swa}${file} },`;
}

async function main() {
  const registryPath = argValue('--lemonade-registry') ?? '/usr/share/lemonade-server/resources/server_models.json';
  const only = argValue('--only')
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (process.argv.includes('--only') && !only?.length) throw new Error('usage: --only <id,id,...> (comma-separated catalog row ids)');
  let rows = CURATED_MODELS.filter((m) => m.modality === 'llm' && (m.backend === 'lemonade' || m.backend === 'ollama'));
  if (only) {
    const known = new Set(rows.map((m) => m.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`--only names no Ollama or Lemonade LLM row: ${unknown.join(', ')}`);
    rows = rows.filter((m) => only.includes(m.id));
  }
  // Only a Lemonade row needs the registry, so Ollama rows can be added on a machine without a Lemonade install.
  const registry = rows.some((m) => m.backend === 'lemonade')
    ? (JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, { checkpoint?: string; recipe?: string; mmproj?: string }>)
    : {};

  const results: Record<string, KvGeometry & { fileBytes: number }> = {};
  const failures: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const m = rows[next++];
      if (!m) break;
      try {
        let source: { url: string; fileBytes: number };
        if (m.backend === 'ollama') {
          source = await ollamaGguf(m.backendModelId);
        } else {
          const entry = registry[m.backendModelId];
          if (!entry?.checkpoint || entry.recipe !== 'llamacpp') throw new Error(`not a llama.cpp model in this Lemonade's registry`);
          source = await lemonadeGguf(entry.checkpoint, entry.mmproj);
        }
        const { url, fileBytes } = source;
        const geometry = kvGeometryFromGguf((await readHeader(url)) as never);
        if (!geometry) throw new Error('no attention geometry in the header');
        results[m.id] = { ...geometry, fileBytes };
        const swa = geometry.slidingLayers ? `, ${geometry.slidingLayers} sliding at ${geometry.slidingWindow}` : '';
        console.log(
          `${m.id.padEnd(40)} ${(geometry.kvBytesPerToken / 1048576).toFixed(4)} MB/token  ${geometry.architecture} ${geometry.kvLayers}/${geometry.blockCount} layers${swa}`,
        );
      } catch (err) {
        failures.push(`${m.id} (${m.backendModelId}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  // Every entry as the file carries it. With `--only` the other entries are kept exactly as they are.
  const lines = new Map<string, string>();
  if (only) {
    const raw = readFileSync(OUT, 'utf8');
    if (raw.includes('\r')) throw new Error(`cannot merge into ${OUT}: it has CRLF line endings (convert them to LF, or run without --only)`);
    const text = raw.split('\n');
    const start = text.findIndex((line) => line.startsWith('export const GGUF_KV_GEOMETRY'));
    const end = text.indexOf('};', start);
    if (start < 0 || end < 0) throw new Error(`${OUT} has no GGUF_KV_GEOMETRY table to merge into`);
    for (const line of text.slice(start + 1, end)) {
      if (!line.trim()) continue;
      const entry = line.match(/^ {2}("(?:[^"\\]|\\.)*"): \{.*\},$/);
      // A line this reader cannot parse would vanish from the rewritten file, so stop before writing.
      if (!entry?.[1]) throw new Error(`cannot merge into ${OUT}: this line is not a generated entry (run without --only to rebuild):\n${line}`);
      lines.set(JSON.parse(entry[1]) as string, line);
    }
  }
  for (const [id, r] of Object.entries(results)) lines.set(id, formatRow(id, r));
  const ids = [...lines.keys()].sort();
  const body = ids.map((id) => lines.get(id)).join('\n');
  writeFileSync(
    OUT,
    `/**
 * GENERATED by scripts/catalog/gen-kv-geometry.ts (last run ${new Date().toLocaleDateString('en-CA')}) — do not hand-edit; re-run it.
 *
 * Each catalog text model's 16-bit KV-cache bytes per token of context, read from the GGUF header of
 * the file its engine serves: Lemonade's registry checkpoint on Hugging Face, or the Ollama registry's model layer.
 * Context sizing uses it where nothing measured exists (\`probeContextCost\` in context-cost.util.ts).
 * It is the cache llama.cpp allocates; the engine's scratch buffers are on top of it. \`fileBytes\` is the
 * files a load maps, which the catalog charges for a row whose footprint was not measured.
 */
export interface GgufKvGeometry {
  architecture: string;
  /** Bytes per token of context in the layers whose cache grows with the window. */
  kvBytesPerToken: number;
  /** Bytes per cached token in the sliding-window layers, which keep only \`slidingWindow\` tokens. */
  slidingKvBytesPerToken?: number;
  slidingWindow?: number;
  /** What a load maps: the weights (every shard) plus the vision projector. */
  fileBytes?: number;
  /** The file's \`context_length\`: the most the model runs at as configured (the catalog caps its window here). */
  contextLength?: number;
}

export const GGUF_KV_GEOMETRY: Readonly<Record<string, GgufKvGeometry>> = {
${body}
};
`,
  );
  console.log(`\nwrote ${ids.length} rows to ${path.relative(process.cwd(), OUT)}`);
  if (failures.length) console.log(`\n${failures.length} not resolved:\n  ${failures.join('\n  ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
