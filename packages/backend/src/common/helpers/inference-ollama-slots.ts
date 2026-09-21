/**
 * How many requests this node's Ollama runs at once: the operator's statement of
 * `OLLAMA_NUM_PARALLEL`, for the pool to place against.
 *
 * The pool ranks candidates by queue depth, and a queue of two means the same thing on every node.
 * It does not: Ollama serves `OLLAMA_NUM_PARALLEL` requests concurrently and queues the rest behind
 * them, so two in flight on a 2-slot node is a full engine, and two on a 4-slot node is half of one.
 * Measured on the fleet 2026-09-21 (fleet-qa B5 cell, 4-way bursts): nodes moved to 2 slots queued
 * requests behind Ollama for 5–10 s to the first token — beta-max 0.47 s → 9.0 s — while 4-slot
 * nodes sat idle, and the fleet aggregate at c=4 fell 14–16 %. Putting the two nodes back at 4
 * slots recovered it; slots, not context, set short-prompt concurrency.
 *
 * `inferenceOllamaSlots` is that statement, kept the way `inferenceMaxNumCtx` keeps the engine's
 * context: written once by the operator (`cihub fleet backends --ollama-parallel N` writes both the
 * daemon's environment and this setting, `cihub pool slots N` this setting alone), absent by
 * default, and advertised to peers so an entry node knows which candidates still have a free slot.
 * The API cannot answer this on its own: `OLLAMA_NUM_PARALLEL` is not exposed, and Ollama 0.34
 * forces a single slot for some model lineages whatever the variable says, so the value is what
 * the operator knows the daemon runs, not a probe.
 *
 * A pool node advertises it in `GET /inference/pool/capabilities` as `ollamaSlots`, omitting the key
 * when it has none, which is also what every older build sends. See `applySlotPlacement` in
 * `hub-pool-proxy.service.ts` for how the entry node uses it, and `poolSlotAwareness` for the knob
 * that turns that on.
 */

/** One sequence is Ollama's own default; a node cannot run fewer. */
export const MIN_INFERENCE_OLLAMA_SLOTS = 1;
/** Far past where any node on this fleet has the KV memory; the same bound `--ollama-parallel` accepts. */
export const MAX_INFERENCE_OLLAMA_SLOTS = 64;

/**
 * A slot count as this build will believe it, or `null` for "not stated".
 *
 * Runs on the READ path, like `clampContextCap`: a peer's advertised value is free-form jsonb it
 * controls, and a persisted value may predate this build's bounds. Anything but an in-range integer
 * reads as not stated, which leaves the candidate exactly where the ranker put it.
 */
export function clampOllamaSlots(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_INFERENCE_OLLAMA_SLOTS && raw <= MAX_INFERENCE_OLLAMA_SLOTS ? raw : null;
}
