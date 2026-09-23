import type { BackendHealthStatus, InferenceBackendType } from '@ci-hub/common/types';

/**
 * The backends whose default port another backend also probes — and which therefore may reach the
 * SAME server on a node that runs only one of them: vllm, mtplx and lucebox all default to host
 * port 8000; llama-server's own 8080 is mlx-dspark's (which is why `LLAMACPP_URL` is opt-in), and
 * the fleet's managed llama-server sits on 8081 where a hand-started one may be too.
 */
export type SharedPortEngine = Extract<InferenceBackendType, 'vllm' | 'mtplx' | 'lucebox' | 'llamacpp'>;

/**
 * Who each engine NAMES ITSELF as, in `data[0].owned_by` of its own `/v1/models` body.
 *
 * Measured against live servers, not guessed: lucebox returns `owned_by:dflash` (its runtime's
 * name, not the product's — which is why this is a table and not a string match on the backend
 * id), mtplx returns `owned_by:mtplx`, vLLM returns `owned_by:vllm`, llama-server returns
 * `owned_by:llamacpp` (and answers `/props` with its model path, per-slot `n_ctx` and
 * `total_slots`, which `llamacpp.backend.ts` reads once the server is its own). Shared with the
 * eval port sweep (`eval/backend-fingerprint.ts`), which learned the first three first.
 */
export const OWNED_BY_ENGINE: Record<string, SharedPortEngine> = {
  dflash: 'lucebox',
  lucebox: 'lucebox',
  mtplx: 'mtplx',
  vllm: 'vllm',
  // llama-server (`ggml-org/llama.cpp`, verified against b11065 and Ollama's bundled build).
  llamacpp: 'llamacpp',
};

/** Model ids from an OpenAI `/v1/models` body. Shared so every reader agrees on the shape. */
export function openAiModelIds(body: unknown): string[] {
  const data = (body as { data?: { id?: unknown }[] } | null)?.data;
  return Array.isArray(data) ? data.map((m) => String(m?.id ?? '')).filter(Boolean) : [];
}

/** `data[0].owned_by` from an OpenAI `/v1/models` body, lowercased. Empty string when absent. */
export function openAiModelOwner(body: unknown): string {
  const data = (body as { data?: { owned_by?: unknown }[] } | null)?.data;
  if (!Array.isArray(data) || !data.length) return '';
  const owner = data[0]?.owned_by;
  return typeof owner === 'string' ? owner.trim().toLowerCase() : '';
}

/** The env var an operator sets to point `type` at its own server — named in the error so the fix is one line. */
const ENDPOINT_VAR: Record<SharedPortEngine, string> = {
  vllm: 'VLLM_URL',
  mtplx: 'MTPLX_URL',
  lucebox: 'SPECULATIVE_INFERENCE_URL',
  llamacpp: 'LLAMACPP_URL',
};

/**
 * The health a backend must report when the server at its URL names itself as a DIFFERENT engine,
 * or `null` when the server is (or may be) its own.
 *
 * Every OpenAI-compatible server answers `/v1/models`, so a health check built on that route
 * cannot tell whose server it reached. On a fleet node serving vLLM on :8000, the Hub reported
 * vllm, mtplx AND lucebox healthy with the same model — three local pool candidates for one
 * engine (each failover hop re-hit the same process), an inventory that advertised the model
 * three times to peers, and a status page that claimed two engines the node has never run.
 *
 * `running: true` because something answered; `healthy: false` so routing, inventory and the
 * tracked-model registry all leave it alone — the same shape lucebox already uses for "up but
 * no weights". A server that does not name itself is left as it was: absent evidence is not
 * evidence of a foreign engine, and the heuristics that could go further belong to the eval
 * sweep, not to a 5-second health probe.
 */
export function foreignEngineHealth(type: SharedPortEngine, body: unknown, baseUrl: string): BackendHealthStatus | null {
  const owner = openAiModelOwner(body);
  const engine = OWNED_BY_ENGINE[owner];
  if (!engine || engine === type) return null;
  return {
    running: true,
    healthy: false,
    modelsLoaded: [],
    error:
      `The server at ${baseUrl} names itself "${owner}" on GET /v1/models — that is the ${engine} backend's server, not ${type}'s. ` +
      `${type} is only offered once it has a server of its own: set ${ENDPOINT_VAR[type]} to its address, or ignore this backend.`,
  };
}
