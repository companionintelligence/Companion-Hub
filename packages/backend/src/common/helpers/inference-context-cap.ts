/**
 * The operator's ceiling on the context window (`num_ctx`) the Hub hands its apps.
 *
 * The handout sizes `CI_LLM_NUM_CTX` from the model's window and this node's memory, and the engine
 * runs whatever default its own environment sets — `OLLAMA_CONTEXT_LENGTH`, written by
 * `cihub fleet backends --ollama-context`. Nothing connected the two. Observed on core-2, 2026-09-20:
 * apps were handed 65536 while Ollama ran `OLLAMA_NUM_PARALLEL=4` at `OLLAMA_CONTEXT_LENGTH=16384`.
 * OpenClaw's first turn reloaded `qwen3-coder:30b` with a 65536 window (`ollama ps` 25 GB → 44 GB,
 * four slots of 64k KV, a ~40 s reload), and every later request at a different `num_ctx` — the
 * harness's 16k default, Hermes — flipped it back, each flip a full reload of a 30B model. On a
 * 10 GB card the same handout spilled the model to CPU.
 *
 * `inferenceMaxNumCtx` is that connection: the operator states the engine's context once, and every
 * handout is capped at it. Absent (the default) is no cap — exactly the sizing the build before it
 * did. The API cannot answer this on its own: `OLLAMA_CONTEXT_LENGTH` is not exposed, and the
 * `context_length` `/api/ps` reports for a loaded model is whatever the last request asked for,
 * which after one oversized handout is the oversized value. So `/api/ps` is read to WARN when the
 * handout disagrees with what is loaded, never to size it.
 *
 * A pool node advertises its cap in `GET /inference/pool/capabilities` as `maxNumCtx`, omitting the
 * key when it has none, which is also what every older build sends. See `poolContextCap` in
 * `app-model-handout.ts` for how the entry node combines the candidates' caps.
 */

/**
 * Below this no agent turn fits — a system prompt and a few tool schemas already exceed it — and a
 * dropped digit is the likelier explanation. Ollama's own historical default.
 */
export const MIN_INFERENCE_MAX_NUM_CTX = 2048;
/** 2^20: past the longest context window any engine on this fleet offers, so a higher cap could never bind. */
export const MAX_INFERENCE_MAX_NUM_CTX = 1_048_576;

/**
 * A cap as this build will believe it, or `null` for "no cap".
 *
 * Runs on the READ path, like `clampPromptCeiling`: a peer's advertised value is free-form jsonb it
 * controls, and a persisted value may predate this build's bounds. Anything but an in-range integer
 * reads as no cap. A cap can only make a handout smaller, so the clamp exists to stop a malformed
 * value from starving an app, not out of distrust.
 */
export function clampContextCap(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_INFERENCE_MAX_NUM_CTX && raw <= MAX_INFERENCE_MAX_NUM_CTX ? raw : null;
}
