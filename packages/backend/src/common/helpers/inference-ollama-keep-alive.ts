/**
 * How long this node's Ollama keeps a model it loaded with no `keep_alive` named: the operator's
 * statement of `OLLAMA_KEEP_ALIVE`, in seconds.
 *
 * Every Hub load holds a model at `keep_alive: -1`, and an unpin hands the model back to the
 * daemon's usual expiry by naming one. Ollama's API does not expose `OLLAMA_KEEP_ALIVE`, so the Hub
 * cannot read it from the daemon. `inferenceOllamaKeepAlive` is that statement, kept the way
 * `inferenceOllamaSlots` keeps `OLLAMA_NUM_PARALLEL`: `cihub fleet backends --ollama-keep-alive 24h`
 * writes both the daemon's environment and this setting (86400), and an operator can set it alone
 * with `PATCH /api/user-settings {"inferenceOllamaKeepAlive": <seconds>}`. Absent, an unpin names
 * Ollama's built-in default, 5 minutes.
 *
 * `-1` is forever, as it is for Ollama: an unpinned model then stays until something unloads it, as
 * every other model on that daemon does. `0` unloads it as soon as it is idle.
 */

/** Ollama's "forever". */
export const MIN_INFERENCE_OLLAMA_KEEP_ALIVE_SECONDS = -1;
/** A year: past any keep-alive the fleet runs (24 h), and still a real expiry. */
export const MAX_INFERENCE_OLLAMA_KEEP_ALIVE_SECONDS = 365 * 24 * 60 * 60;

/**
 * A keep-alive as this build will believe it, or `null` for "not stated". On the READ path, like
 * `clampOllamaSlots`: a persisted value may predate this build's bounds, and then an unpin names
 * Ollama's default rather than a figure nobody can vouch for.
 */
export function clampOllamaKeepAliveSeconds(raw: unknown): number | null {
  return typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= MIN_INFERENCE_OLLAMA_KEEP_ALIVE_SECONDS &&
    raw <= MAX_INFERENCE_OLLAMA_KEEP_ALIVE_SECONDS
    ? raw
    : null;
}
