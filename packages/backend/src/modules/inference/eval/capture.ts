/**
 * WHAT A RESULT ROW REMEMBERS ABOUT THE REQUEST THAT PRODUCED IT.
 *
 * Before this existed a result row carried nine fields — id, backend, kind, endpoint, notes, path,
 * promptId, score, ts — and a reader could therefore never answer the first question anyone asks of a
 * red row: *what did we send, and what came back*. "This dialect returned EMPTY on three machines" was
 * a conclusion reached by re-running the request by hand, because the run itself had thrown the
 * evidence away. Every row now carries that evidence.
 *
 * ── Where this may point, and where it may not ─────────────────────────────────────────────────
 * The Hub's own routing log deliberately stores METADATA ONLY: it runs on an appliance holding a
 * person's memory, and recording the text of their inference would be a privacy defect. NOTHING here
 * changes that, and this file must never be cited as precedent for loosening it.
 *
 * This captures the traffic of an EVALUATION: prompts an operator chose from the bank in this
 * directory, sent by the operator to endpoints the operator controls, to find out whether those
 * endpoints answer correctly. There is no third party's text in that loop. The moment a caller points
 * this at real user traffic the loop is different and the privacy rule of the routing log applies
 * instead — so a caller that cannot say the prompts are its own has no business assembling one of
 * these envelopes.
 *
 * ── What redaction here does and does not promise ──────────────────────────────────────────────
 * Credentials are the one thing stripped regardless: `redactHeaders` and `redactUrl` replace the value
 * of any header or query parameter whose NAME reads as a credential, and both keep the name so "we
 * sent a token" stays visible. That is NAME-BASED matching and nothing more. It does not inspect
 * values, so a bare credential in an unrecognised format — a key in a header nobody would call a
 * credential, an opaque path segment, a secret inside a JSON request body — is NOT detected and will
 * be captured. Bodies in particular are stored as sent (bounded): they are the measurement, and
 * scrubbing them by pattern would corrupt the evidence a red row exists to preserve. A caller sending
 * a credential anywhere but a credential-named header or parameter is capturing it.
 *
 * ── Bounds are the whole design ────────────────────────────────────────────────────────────────
 * The prompt bank contains an entry that expands to ~1.1 MILLION characters, and a run is 500+ rows
 * held in memory and appended to one file. Storing a payload whole is therefore never an option:
 * everything goes through `captureText`, which keeps a bounded head AND tail with an explicit marker
 * naming how much was dropped. Head-and-tail rather than head alone because the interesting half of a
 * needle-in-a-haystack prompt is its LAST line, and the interesting half of a degenerate response is
 * where it started looping — a head-only excerpt of either shows filler and proves nothing.
 *
 * ── Not on the hot path ────────────────────────────────────────────────────────────────────────
 * Every function here is pure and synchronous, operates on strings the dispatcher already built for
 * the wire (the request body is captured from the very string handed to `fetch`, never re-serialized),
 * and is called AFTER the response has been read and graded. Nothing here awaits, retries, or reaches
 * the network, so it cannot move a TTFT number or change concurrency.
 */

import type { LlmAssertCheck } from './prompt-bank';

/** Bumped when the shape below changes incompatibly, so a reader of an old capture knows what it has. */
export const CAPTURE_SCHEMA = 1;

/**
 * Per-field character budgets.
 *
 * Sized so the worst-case row (a big request body + a long generation + a raw embedding body) costs
 * roughly 10 KB of capture, which puts a 531-row run around 5 MB — large enough to be useful, small
 * enough to open in an editor. They are deliberately NOT one shared number: a raw embedding body is
 * 768 floats of noise and earns less room than the generated text a human reads.
 */
export interface CaptureLimits {
  /** The exact JSON body sent to the backend. */
  requestBody: number;
  /** Assembled assistant text (streamed or extracted). */
  responseText: number;
  /** Raw response body, for the non-streamed path — where an error body or a vector lives. */
  responseBody: number;
  /** Transport/abort error message. */
  error: number;
  /** A remote command line. */
  command: number;
  /** stdout / stderr tail kept per app row. */
  outputTail: number;
  /** One header value. */
  headerValue: number;
}

export const CAPTURE_LIMITS: CaptureLimits = {
  requestBody: 4000,
  responseText: 4000,
  responseBody: 2000,
  error: 1000,
  command: 2000,
  outputTail: 2000,
  headerValue: 256,
};

/**
 * Every budget multiplied by `scale`, for an operator who wants a run they can read in full detail (or
 * one that has to stay small). Written as an explicit field list rather than a mapped
 * `Object.fromEntries` so that adding a limit to `CaptureLimits` and forgetting it here is a type error
 * rather than a budget that silently ignores the scale.
 */
export function scaleLimits(scale: number, base: CaptureLimits = CAPTURE_LIMITS): CaptureLimits {
  const s = (n: number) => Math.max(0, Math.round(n * scale));
  return {
    requestBody: s(base.requestBody),
    responseText: s(base.responseText),
    responseBody: s(base.responseBody),
    error: s(base.error),
    command: s(base.command),
    outputTail: s(base.outputTail),
    headerValue: s(base.headerValue),
  };
}

/**
 * A bounded excerpt of a string, plus the arithmetic needed to say honestly how bounded it is.
 *
 * `chars` is the length of the ORIGINAL — the field exists so a reader can print "1,100,000 chars"
 * next to a 4 KB excerpt rather than implying the excerpt is the whole thing.
 */
export interface CapturedText {
  /** The retained text: head, marker, tail. Equal to the original when `truncated` is false. */
  text: string;
  /** Length of the original string, before anything was dropped. */
  chars: number;
  truncated: boolean;
  /** Characters dropped from the middle. Always 0 when `truncated` is false. */
  omitted: number;
}

/**
 * The marker is text, not a flag, because the excerpt is going to be read by a human and pasted into
 * an issue — and a silent join of a head to a tail reads as a real response that says something
 * bizarre in the middle. It names the count so the excerpt is self-describing out of context.
 */
export function truncationMarker(omitted: number, total: number): string {
  return `\n…[capture truncated ${omitted} of ${total} chars]…\n`;
}

/**
 * Bounded head+tail excerpt of any value.
 *
 * `tailShare` is the fraction of the budget spent on the END of the string. The default keeps a
 * quarter, which is what makes a needle prompt (needle in the suffix) and a looping response (loop
 * visible at both ends) readable from the excerpt alone. Pass 0 for a value where only the head
 * carries meaning.
 *
 * The retained text is `limit` characters of the original PLUS the marker, so a caller sizing a file
 * budget should count the marker too.
 *
 * Returns null for null/undefined so an absent field stays absent rather than becoming `""`, which a
 * reader cannot tell apart from a genuinely empty response — and "genuinely empty" is a real finding.
 */
export function captureText(value: unknown, limit: number, tailShare = 0.25): CapturedText | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'string' ? value : String(value);
  if (!(limit > 0)) return { text: '', chars: s.length, truncated: s.length > 0, omitted: s.length };
  if (s.length <= limit) return { text: s, chars: s.length, truncated: false, omitted: 0 };
  const share = Math.min(Math.max(tailShare, 0), 1);
  const tail = Math.min(limit - 1, Math.floor(limit * share));
  const head = limit - tail;
  const omitted = s.length - limit;
  const marker = truncationMarker(omitted, s.length);
  const text = tail > 0 ? `${s.slice(0, head)}${marker}${s.slice(s.length - tail)}` : `${s.slice(0, head)}${marker}`;
  return { text, chars: s.length, truncated: true, omitted };
}

/**
 * Bounded excerpt that keeps the END.
 *
 * For a process's stdout/stderr the head is the banner and the tail is the failure, so the head is
 * what gets dropped — the opposite of `captureText`'s default, and the reason this is a separate
 * function rather than `tailShare: 1` (which would still spend a character on the head).
 */
export function captureTail(value: unknown, limit: number): CapturedText | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'string' ? value : String(value);
  if (!(limit > 0)) return { text: '', chars: s.length, truncated: s.length > 0, omitted: s.length };
  if (s.length <= limit) return { text: s, chars: s.length, truncated: false, omitted: 0 };
  const omitted = s.length - limit;
  return { text: `${truncationMarker(omitted, s.length)}${s.slice(s.length - limit)}`, chars: s.length, truncated: true, omitted };
}

/**
 * Bounded excerpt of a value serialized as JSON. A value that cannot be serialized (a cycle, a BigInt)
 * is described rather than dropped — "[unserializable: …]" in the excerpt beats a null field that a
 * reader mistakes for "the backend returned nothing".
 */
export function captureJson(value: unknown, limit: number, tailShare = 0.25): CapturedText | null {
  if (value === null || value === undefined) return null;
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch (e) {
    s = `[unserializable: ${e instanceof Error ? e.message : String(e)}]`;
  }
  return captureText(s, limit, tailShare);
}

// ─── Credential redaction ─────────────────────────────────────────────────────

/** The redaction placeholder — present rather than absent, so "we sent a token" stays visible. */
export const REDACTED = '«redacted»';

/** Header names whose value is always a credential. */
export const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
]);

/**
 * A NAME that reads as a credential, in either a header or a query parameter.
 *
 * Segment-anchored (`-`, `_`, `.` or an end) so `x-auth-token` and `api_key` match while `monkey` and
 * `www-authenticate` do not. This is a superset of `REDACTED_HEADERS`, which stays as the explicit
 * list of the ones that are certain; the pattern catches the vendor-specific spellings nobody
 * enumerated. False positives are cheap here — a redacted `x-session-id` costs a little diagnostic
 * detail; a captured token costs a rotation.
 */
const CREDENTIAL_NAME_RE =
  /(^|[-_.])(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth|authorization|bearer|cookie|credential|key|passwd|password|pwd|secret|session|sig|signature|token)([-_.]|$)/i;

/**
 * Whether a header or parameter name reads as a credential. Names only — values are never inspected.
 *
 * A percent-encoded parameter name is decoded first, and a name that will not decode is tested as
 * written: a malformed escape is not a reason to skip the check and capture the value.
 */
export function isCredentialName(name: string): boolean {
  let n = String(name).toLowerCase();
  if (n.includes('%')) {
    try {
      n = decodeURIComponent(n);
    } catch {
      // Keep the raw form; a name we cannot decode still gets pattern-matched.
    }
  }
  return REDACTED_HEADERS.has(n) || CREDENTIAL_NAME_RE.test(n);
}

/**
 * Copy a header map, replacing credential values with a placeholder.
 *
 * The header is KEPT with its value replaced, not deleted: "this request carried an Authorization
 * header" is diagnostic (a 401 from a backend the operator thought was open), and the token itself
 * never is. Values are also length-bounded — a stray header is not a place to spend a KB.
 */
export function redactHeaders(headers: Record<string, string> | null | undefined, limit = CAPTURE_LIMITS.headerValue): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = isCredentialName(k) ? REDACTED : String(v).slice(0, limit);
  }
  return out;
}

/**
 * Replace credential-looking values inside a URL: the `user:pass@` authority, and any query parameter
 * whose name reads as a credential.
 *
 * The URL is captured on every row, so a backend addressed as `…?api_key=…` would otherwise write the
 * key into the results of every single case against it. Parsed by hand rather than via `URL` because a
 * captured URL may be relative or malformed and must still come back redacted rather than throwing.
 *
 * Only NAMED parameters are covered. A credential carried as a bare path segment
 * (`/v1/<token>/chat`) is indistinguishable from an id and is captured as-is.
 */
export function redactUrl(url: string | null | undefined): string {
  const s = String(url ?? '');
  if (!s) return s;
  const withoutUserinfo = s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, `$1${REDACTED}@`);
  const q = withoutUserinfo.indexOf('?');
  if (q === -1) return withoutUserinfo;
  const head = withoutUserinfo.slice(0, q);
  const rest = withoutUserinfo.slice(q + 1);
  const hashAt = rest.indexOf('#');
  const query = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : rest.slice(hashAt);
  const scrubbed = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      return isCredentialName(name) ? `${name}=${REDACTED}` : pair;
    })
    .join('&');
  return `${head}?${scrubbed}${fragment}`;
}

/** Response headers worth keeping on every row, regardless of dialect or backend. */
export const RESPONSE_HEADERS_OF_INTEREST: readonly string[] = [
  'content-type',
  'content-length',
  'transfer-encoding',
  'retry-after',
  'server',
  'x-request-id',
];

/**
 * Pull a named subset out of a fetch `Headers` (or a plain record) into a plain object, redacted.
 *
 * Named subset rather than "all of them" on purpose: a response can carry a couple of KB of CORS and
 * cache headers that say nothing about whether the model answered, and hundreds of rows of that is
 * megabytes of noise a reader would have to skip anyway.
 */
export function pickHeaders(
  source: { get(name: string): string | null } | Record<string, string> | null | undefined,
  names: readonly string[],
  limit = CAPTURE_LIMITS.headerValue,
): Record<string, string> {
  if (!source) return {};
  const get =
    typeof (source as { get?: unknown }).get === 'function'
      ? (n: string) => (source as { get(name: string): string | null }).get(n)
      : (n: string) => {
          const rec = source as Record<string, string>;
          const hit = Object.keys(rec).find((k) => k.toLowerCase() === n.toLowerCase());
          return hit === undefined ? null : (rec[hit] ?? null);
        };
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = get(name);
    if (v !== null && v !== undefined && v !== '') out[name.toLowerCase()] = isCredentialName(name) ? REDACTED : String(v).slice(0, limit);
  }
  return out;
}

/**
 * Total characters of prompt text inside an already-built request body.
 *
 * Read off the BODY rather than re-expanding the prompt: expanding the oversized-context entry
 * allocates ~1.1 MB, and doing that a second time purely to report a number would put real work on the
 * dispatch path this file promises to stay off. The body object already holds the expanded strings, so
 * this is a walk over a handful of fields.
 *
 * Returns null when the body carries no recognizable prompt field — an honest "not known" rather than
 * a 0 that reads as "we sent an empty prompt".
 */
export function promptCharsOf(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  let total = 0;
  let found = false;
  const add = (v: unknown) => {
    if (typeof v === 'string') {
      total += v.length;
      found = true;
    }
  };
  if (Array.isArray(b.messages)) {
    for (const m of b.messages) add((m as Record<string, unknown> | null)?.content);
  }
  add(b.prompt);
  add(b.system);
  if (Array.isArray(b.input)) for (const v of b.input) add(v);
  else add(b.input);
  return found ? total : null;
}

// ─── The captured envelope ────────────────────────────────────────────────────
// One shape for all three kinds. A reader that branches on `capture.kind` and then finds three
// different field names for "how long did it take" is three renderers pretending to be one, so
// `request` / `response` / `timing` / `verdict` mean the same thing on an llm row, an agent row and an
// app row; the kind-specific parts live under `request.body`, `response.text` and `output`.

export interface CaptureTiming {
  /** Epoch ms the request left. */
  startedAt: number;
  /** Wall clock start→verdict, the same number the row already reports as `durationMs`. */
  durationMs: number | null;
  /** Time to first token, streamed rows only. null everywhere else — not 0. */
  ttftMs: number | null;
}

export interface CaptureVerdict {
  score: string;
  ok: boolean;
  /** Where the failure was: `http-status` (bad status) vs `assertion` (2xx, wrong body). */
  kind: string | null;
  failures: string[];
  refused?: boolean;
  degenerate?: boolean;
  degenerateReason?: string | null;
  mojibake?: boolean;
  mojibakeReason?: string | null;
  emptyCompletion?: boolean;
  /** A 2xx with empty `content` whose answer landed in the hidden reasoning channel instead. */
  answeredInReasoning?: boolean;
  budgetTruncated?: boolean;
  softened?: boolean;
}

export interface CaptureRequest {
  method: string;
  /** Redacted by `redactUrl` — credential-named query parameters carry the placeholder, not the value. */
  url: string;
  headers: Record<string, string>;
  /** The exact bytes sent, bounded. null for a request with no body (a GET, a local check). */
  body: CapturedText | null;
  /** Characters of prompt text inside that body, before truncation. */
  promptChars?: number | null;
  timeoutMs?: number | null;
  /** llm only — which wire dialect, which model, and whether it went through the Hub pool. */
  dialect?: string;
  model?: string;
  backend?: string;
  transport?: 'direct' | 'pool';
  stream?: boolean;
}

export interface CaptureResponse {
  status: number;
  statusText?: string | null;
  headers: Record<string, string>;
  /** Assembled visible text — the streamed concatenation, or what was extracted from the body. */
  text: CapturedText | null;
  /** Raw body, when we have one. Always null for a streamed row; see `rawNote`. */
  raw: CapturedText | null;
  /** Why `raw` is null, when it is null for a reason rather than for lack of content. */
  rawNote?: string | null;
  /** 'sse' | 'ndjson' | null — null means the response was read whole. */
  framing?: string | null;
  finishReason?: string | null;
  /** Characters of HIDDEN reasoning. Never part of `text`. */
  reasoningChars?: number | null;
  /** Embedding rows: the width of the returned vector, which is their answer instead of text. */
  vectorLength?: number | null;
}

export interface CaptureUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  tokensPerSec: number | null;
  charsPerSec: number | null;
  /** Exactly what the backend reported, un-normalized — bounded, because some report a lot. */
  reported: CapturedText | null;
}

/** stdout / stderr tails and the command that produced them (app rows). */
export interface CaptureOutput {
  /** The command actually launched, bounded. */
  command: CapturedText | null;
  /** How the item was handed to that command, when it wasn't on the command line. */
  dispatch?: string | null;
  stdout: CapturedText | null;
  stderr: CapturedText | null;
}

export interface CaptureEnvelope {
  schema: number;
  kind: 'llm' | 'agent' | 'app';
  request: CaptureRequest | null;
  response: CaptureResponse | null;
  timing: CaptureTiming;
  usage?: CaptureUsage | null;
  output?: CaptureOutput | null;
  /** Per-assertion outcomes: what each clause asked for, what it saw, and why it passed or failed. */
  checks: LlmAssertCheck[];
  verdict: CaptureVerdict;
  /** Transport failure — a row with this has `response: null` and nothing was ever graded. */
  error?: { message: CapturedText | null; aborted: boolean } | null;
}

export interface LlmCaptureInput {
  request: {
    url: string;
    method?: string;
    headers: Record<string, string>;
    /** The exact string handed to fetch. Captured, never re-serialized. */
    bodyText: string | null;
    /** The parsed body object, used only to count prompt characters without re-expanding anything. */
    bodyObject?: unknown;
    dialect: string;
    model: string;
    backend: string;
    transport: 'direct' | 'pool';
    stream: boolean;
    timeoutMs: number;
  };
  response?: {
    status: number;
    statusText?: string | null;
    headers: Record<string, string>;
    text: string;
    rawBody?: string | null;
    rawNote?: string | null;
    framing?: string | null;
    finishReason?: string | null;
    reasoningChars?: number | null;
    vectorLength?: number | null;
  } | null;
  timing: CaptureTiming;
  /** `reported` is the backend's raw usage object; everything else is the already-derived number. */
  usage?: Omit<Partial<CaptureUsage>, 'reported'> & { reported?: unknown };
  checks?: LlmAssertCheck[];
  verdict: CaptureVerdict;
  error?: { message: string; aborted: boolean } | null;
  limits?: Partial<CaptureLimits>;
}

/**
 * Assemble one LLM row's captured detail.
 *
 * Everything it needs has already been computed by the dispatcher — this only redacts, bounds and
 * names the fields. Keeping the assembly here (rather than inline in whatever drives the run) is what
 * lets a test assert the exact shape a reader will get without opening a socket.
 */
export function buildLlmCapture(input: LlmCaptureInput): CaptureEnvelope {
  const lim = { ...CAPTURE_LIMITS, ...(input.limits ?? {}) };
  const r = input.request;
  const res = input.response ?? null;
  return {
    schema: CAPTURE_SCHEMA,
    kind: 'llm',
    request: {
      method: r.method ?? 'POST',
      url: redactUrl(r.url),
      headers: redactHeaders(r.headers, lim.headerValue),
      body: captureText(r.bodyText, lim.requestBody),
      promptChars: promptCharsOf(r.bodyObject),
      timeoutMs: r.timeoutMs,
      dialect: r.dialect,
      model: r.model,
      backend: r.backend,
      transport: r.transport,
      stream: r.stream,
    },
    response: res
      ? {
          status: res.status,
          statusText: res.statusText ?? null,
          // Redacted too: a `set-cookie` on the way back is as much a credential as one on the way out.
          headers: redactHeaders(res.headers, lim.headerValue),
          text: captureText(res.text, lim.responseText),
          raw: captureText(res.rawBody ?? null, lim.responseBody),
          rawNote: res.rawNote ?? null,
          framing: res.framing ?? null,
          finishReason: res.finishReason ?? null,
          reasoningChars: res.reasoningChars ?? null,
          vectorLength: res.vectorLength ?? null,
        }
      : null,
    timing: input.timing,
    usage: input.usage
      ? {
          promptTokens: input.usage.promptTokens ?? null,
          completionTokens: input.usage.completionTokens ?? null,
          totalTokens: input.usage.totalTokens ?? null,
          tokensPerSec: input.usage.tokensPerSec ?? null,
          charsPerSec: input.usage.charsPerSec ?? null,
          reported: captureJson(input.usage.reported ?? null, lim.responseBody, 0),
        }
      : null,
    checks: input.checks ?? [],
    verdict: input.verdict,
    error: input.error ? { message: captureText(input.error.message, lim.error, 0), aborted: input.error.aborted } : null,
  };
}

export interface AgentCaptureInput {
  request: { url: string | null; method: string; headers: Record<string, string>; bodyText: string | null; timeoutMs: number } | null;
  response?: { status: number; statusText?: string | null; headers: Record<string, string>; text: string; rawBody?: string | null } | null;
  timing: CaptureTiming;
  checks?: LlmAssertCheck[];
  verdict: CaptureVerdict;
  error?: { message: string; aborted: boolean } | null;
  limits?: Partial<CaptureLimits>;
}

/**
 * Assemble one agent-check row's captured detail, in the same envelope.
 *
 * An agent row IS one assertion, so its `checks` array holds exactly one entry — that is not padding
 * to match the llm shape, it is the honest count. A local check (`request: null`) captures no request
 * because there was none: the predicate ran against credentials the Hub had already handed over.
 */
export function buildAgentCapture(input: AgentCaptureInput): CaptureEnvelope {
  const lim = { ...CAPTURE_LIMITS, ...(input.limits ?? {}) };
  const r = input.request;
  const res = input.response ?? null;
  return {
    schema: CAPTURE_SCHEMA,
    kind: 'agent',
    request: r
      ? {
          method: r.method,
          url: redactUrl(r.url ?? ''),
          headers: redactHeaders(r.headers, lim.headerValue),
          body: captureText(r.bodyText, lim.requestBody),
          timeoutMs: r.timeoutMs,
        }
      : null,
    response: res
      ? {
          status: res.status,
          statusText: res.statusText ?? null,
          headers: redactHeaders(res.headers, lim.headerValue),
          text: captureText(res.text, lim.responseText),
          raw: captureText(res.rawBody ?? null, lim.responseBody),
          rawNote: null,
          framing: null,
        }
      : null,
    timing: input.timing,
    usage: null,
    checks: input.checks ?? [],
    verdict: input.verdict,
    error: input.error ? { message: captureText(input.error.message, lim.error, 0), aborted: input.error.aborted } : null,
  };
}

export interface AppCaptureInput {
  /** The command line the harness on the target was launched with. */
  command: string | null;
  /** How this particular app reached that command, when it was not named on the line. */
  dispatch?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  timing: CaptureTiming;
  verdict: CaptureVerdict;
  limits?: Partial<CaptureLimits>;
}

/**
 * Assemble one app row's captured detail.
 *
 * An app row has no HTTP request of its own — the work happens inside a harness process running on the
 * target, and this side only sees the command it launched and whatever that process wrote outside its
 * structured event stream. So `request`/`response` are null and the evidence lives in `output`. That
 * is a smaller claim than the llm rows make, and it is stated as null rather than faked, because a
 * reader shown an empty "Response" panel on every app row learns to ignore the panel.
 *
 * The tails are what the target's channel emitted around this verdict: non-structured stdout (remote
 * runtime and setup failures land there) and stderr. Both are per-target, not per-app — a target
 * running two apps concurrently interleaves their output — so a reader must label them as the
 * target's, not the app's.
 */
export function buildAppCapture(input: AppCaptureInput): CaptureEnvelope {
  const lim = { ...CAPTURE_LIMITS, ...(input.limits ?? {}) };
  return {
    schema: CAPTURE_SCHEMA,
    kind: 'app',
    request: null,
    response: null,
    timing: input.timing,
    output: {
      command: captureText(input.command, lim.command, 0),
      dispatch: input.dispatch ?? null,
      stdout: captureTail(input.stdout ?? null, lim.outputTail),
      stderr: captureTail(input.stderr ?? null, lim.outputTail),
    },
    checks: [],
    verdict: input.verdict,
  };
}

export interface OutputTailOptions {
  maxLines?: number;
  maxLineChars?: number;
}

/**
 * A bounded, append-only tail of a process's output.
 *
 * A target under a full run emits megabytes over its channel, and every byte of it is a candidate for
 * a per-app capture that will be written hundreds of times. Keeping a fixed number of bounded LINES —
 * rather than a growing string trimmed at capture time — is what makes the memory cost of watching a
 * target constant instead of proportional to how long the run lasts.
 *
 * An instance rather than module state: two targets must never share a buffer.
 */
export class OutputTail {
  readonly maxLines: number;
  readonly maxLineChars: number;

  #lines: string[] = [];

  constructor(opts: OutputTailOptions = {}) {
    this.maxLines = Math.max(1, Number(opts.maxLines) || 40);
    this.maxLineChars = Math.max(1, Number(opts.maxLineChars) || 500);
  }

  /** Append a chunk (may contain many lines, or a partial one). Blank lines are dropped. */
  push(chunk: string): void {
    for (const raw of String(chunk).split('\n')) {
      const line = raw.trimEnd();
      if (!line) continue;
      this.#lines.push(line.length > this.maxLineChars ? `${line.slice(0, this.maxLineChars)}…` : line);
      if (this.#lines.length > this.maxLines) this.#lines.shift();
    }
  }

  /** The retained lines, newest last, joined with newlines. */
  text(): string {
    return this.#lines.join('\n');
  }

  /** How many lines are currently retained. */
  size(): number {
    return this.#lines.length;
  }
}
