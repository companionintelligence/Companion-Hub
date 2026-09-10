/**
 * Who is answering the shared :8000 — pure decision, no I/O.
 *
 * vllm, mtplx and lucebox all default to port 8000, so a reachable port cannot say which one it is.
 * A caller reads three cheap GETs (`/v1/models`, `/version`, `/health`) and this function turns those
 * three responses into a verdict. It is a pure function for the same reason model choice is: a wrong
 * verdict here is SILENT — the walk still completes, it just attributes rows to a backend that isn't
 * installed — and that is the class of bug a unit test catches and a dashboard never will.
 *
 * WHY the `/health`-alone rule was not enough. An unrelated service can own :8000 and answer
 * `GET /health` with `{"status":"ok","model":"…"}` while 404ing `/v1/models` and
 * `/v1/chat/completions`. Under the old rule that made it "lucebox with 0 models" on every probe — a
 * backend nobody installed, reported present, which then swallowed the honest "lucebox is not
 * reachable here" row. So a 200 on `/health` is now necessary and not sufficient: the thing also has
 * to expose an OpenAI model list, because that is the surface all three of these backends are
 * actually driven through.
 */

import type { InferenceBackendType } from '@ci-hub/common/types';

/**
 * The three backends that share :8000. Ollama, lemonade and dspark have ports of their own.
 *
 * Narrowed from the canonical backend tuple rather than spelled out, so renaming a backend there is
 * a compile error here instead of a fingerprint that can never match.
 */
export type SharedPortBackend = Extract<InferenceBackendType, 'vllm' | 'mtplx' | 'lucebox'>;

/** One probe response, reduced to what the verdict depends on. `null` = the request never landed. */
export interface ProbeResponse {
  status: number;
  body?: unknown;
}

export interface SharedPortProbe {
  /** GET {base}/v1/models */
  models: ProbeResponse | null;
  /** GET {base}/version */
  version: ProbeResponse | null;
  /** GET {base}/health */
  health: ProbeResponse | null;
}

export type SharedPortVerdict =
  | { kind: 'match'; backend: SharedPortBackend; via: string }
  /** Nothing here that this tool can drive. `reason` is written into the skip row, not swallowed. */
  | { kind: 'none'; reason: string | null };

/**
 * An OpenAI-compatible server MUST answer `/v1/models` — with a list, or with an auth refusal when the
 * operator secured it and we hold no token. Both prove the route exists. A 404/405 proves it does not,
 * and a server without that route cannot serve `/v1/chat/completions` either, which is the only thing
 * an inference walk would ever ask it for.
 *
 * A 200 must also carry an OpenAI-shaped body, because status alone is not enough. Measured against
 * OpenHands, which also defaults to :8000: it answers `GET /health` with `{"status":"ok"}` AND
 * `GET /v1/models` with **HTTP 200 and its own HTML index page** — a single-page-app catch-all route.
 * Under a status-only rule that is "lucebox with 0 models", a backend nobody installed, reported
 * present on every probe, which then swallows the honest "lucebox is not reachable here" skip. Same
 * regression as the one above, arriving through a 200 instead of a 404.
 *
 * 401/403 are exempt: a guarded route returns no inventory to inspect, and demanding one would
 * discard a real backend for being secured.
 */
function hasOpenAiModelRoute(models: ProbeResponse | null): boolean {
  if (!models) return false;
  if (models.status === 401 || models.status === 403) return true;
  return models.status === 200 && Array.isArray((models.body as { data?: unknown } | null)?.data);
}

/** Extract model ids from an OpenAI `/v1/models` body. Shared with the caller so both agree on shape. */
export function openAiModelIds(body: unknown): string[] {
  const data = (body as { data?: { id?: string }[] } | null)?.data;
  return Array.isArray(data) ? data.map((m) => String(m?.id ?? '')).filter(Boolean) : [];
}

/**
 * Who each of the three NAMES ITSELF as, in `data[0].owned_by` of its own `/v1/models` body.
 *
 * Measured against live servers, not guessed: lucebox returns `owned_by:dflash` (its runtime's name,
 * not the product's — which is exactly why this table exists rather than a string match on the
 * backend id), mtplx returns `owned_by:mtplx`, vLLM returns `owned_by:vllm`. It is the only field the
 * three actually disagree on, so when it is present it beats every route-shape heuristic below —
 * those exist because this field may be absent.
 */
const OWNED_BY_BACKEND: Record<string, SharedPortBackend> = {
  dflash: 'lucebox',
  lucebox: 'lucebox',
  mtplx: 'mtplx',
  vllm: 'vllm',
};

/** `data[0].owned_by` from an OpenAI `/v1/models` body, lowercased. Empty string when absent. */
export function openAiModelOwner(body: unknown): string {
  const data = (body as { data?: { owned_by?: unknown }[] } | null)?.data;
  if (!Array.isArray(data) || !data.length) return '';
  const owner = data[0]?.owned_by;
  return typeof owner === 'string' ? owner.trim().toLowerCase() : '';
}

/**
 * Order is by signature specificity: vLLM is the only one of the three with `/version`; lucebox is
 * the only one of the remaining two documented to serve `/health`; mtplx is the fallback when only
 * `/v1/models` answers. The lucebox branch must clear `hasOpenAiModelRoute` as well — see that
 * function for the servers that made it necessary.
 *
 * A wrong verdict BETWEEN the three only mislabels the row's backend; the request path is identical
 * for all three. A wrong verdict between "one of the three" and "not an LLM server at all" is the
 * expensive one, and that is the boundary this function is careful about.
 */
export function fingerprintSharedPort(probe: SharedPortProbe): SharedPortVerdict {
  const { models, version, health } = probe;

  // The server's own claim first. A backend that names itself needs no fingerprinting, and the
  // heuristics below cannot tell lucebox from mtplx when both answer only /v1/models.
  const owner = OWNED_BY_BACKEND[openAiModelOwner(models?.body)];
  if (models?.status === 200 && owner) {
    return { kind: 'match', backend: owner, via: `GET /v1/models (owned_by=${openAiModelOwner(models.body)})` };
  }

  if (version?.status === 200 && version.body && typeof version.body === 'object' && 'version' in (version.body as object)) {
    return { kind: 'match', backend: 'vllm', via: 'GET /version' };
  }

  if (health?.status === 200) {
    if (hasOpenAiModelRoute(models)) {
      return { kind: 'match', backend: 'lucebox', via: 'GET /health + /v1/models' };
    }
    // The interesting negative: something IS listening and healthy, it just isn't one of ours.
    return {
      kind: 'none',
      reason:
        'something here answers GET /health with 200 but has no OpenAI /v1/models inventory ' +
        `(got ${models ? `HTTP ${models.status}${models.status === 200 ? ' with a non-OpenAI body' : ''}` : 'no response'}) — treated as NOT an LLM backend, ` +
        `because vllm/mtplx/lucebox are all driven through /v1/*. Configure the backend's endpoint explicitly if this is wrong.`,
    };
  }

  // Same rule for the fallback: a bare 200 is not evidence, only an OpenAI-shaped 200 is. Without
  // this, any web app on a swept port becomes "mtplx with 0 models".
  if (hasOpenAiModelRoute(models)) {
    return { kind: 'match', backend: 'mtplx', via: 'GET /v1/models (fingerprint ambiguous)' };
  }

  return { kind: 'none', reason: null };
}
