/**
 * Hardware-aware context-length (num_ctx) selection.
 *
 * Ollama, left to its own defaults, sizes the context window from the memory it
 * sees. On unified-memory APUs that pool is huge (e.g. 100+ GiB GTT), so it
 * defaults to the model's full window (e.g. 262144) even for a one-line chat —
 * which wastes memory on a giant KV cache and slows prefill. This picks a
 * sensible default scaled to the memory left after the model's weights, capped
 * by the model's own maximum context window.
 *
 * The ladder is a heuristic (per-token KV cost is model-specific and not modeled
 * here) and is intentionally conservative; it mirrors the ladder used by CI-OS's
 * host-side `recommend_ollama_context_length`.
 */
export interface ContextLengthInput {
  /** Memory usable for inference, in MB (HardwareProfile.effectiveInferenceMemoryMb). */
  effectiveInferenceMemoryMb: number;
  /** Approximate resident size of the model's weights, in MB. */
  modelFootprintMb: number;
  /** The model's maximum supported context window, in tokens. */
  modelContextWindow: number;
  /**
   * Optional app-specific minimum context window, in tokens. Some apps cannot
   * function below a hard floor — e.g. Hermes Agent fatally rejects any window
   * below 64K. When set, the recommendation is raised up to this floor (the
   * memory ladder may pick something smaller on constrained hardware), but it is
   * still capped by the model's own window: a model whose maximum is below the
   * floor simply cannot satisfy it, and the app is expected to surface that.
   */
  minContextLength?: number;
}

const FALLBACK_CONTEXT = 8192;
const FLOOR_CONTEXT = 4096;

/** Returns a hardware-appropriate num_ctx in tokens, never exceeding the model's window. */
export function recommendContextLength(input: ContextLengthInput): number {
  const { effectiveInferenceMemoryMb, modelFootprintMb, modelContextWindow, minContextLength } = input;
  const cap = modelContextWindow > 0 ? modelContextWindow : FALLBACK_CONTEXT;
  // App-specific floor, never raised above what the model can actually serve.
  const floor = Math.min(Math.max(0, minContextLength ?? 0), cap);

  if (!Number.isFinite(effectiveInferenceMemoryMb) || effectiveInferenceMemoryMb <= 0) {
    return Math.min(Math.max(FALLBACK_CONTEXT, floor), cap);
  }

  const freeForContextMb = effectiveInferenceMemoryMb - Math.max(0, modelFootprintMb || 0);

  let ladder: number;
  if (freeForContextMb >= 16384) ladder = 65536;
  else if (freeForContextMb >= 8192) ladder = 32768;
  else if (freeForContextMb >= 4096) ladder = 16384;
  else if (freeForContextMb >= 2048) ladder = 8192;
  else ladder = FLOOR_CONTEXT;

  return Math.min(Math.max(ladder, floor), cap);
}

/**
 * Per-app minimum context window, in tokens. Apps that cannot function below a
 * hard floor declare it here so EVERY Hub code path that sizes their context —
 * the `credentials.env` endpoint (AppCredentialsService) and the standardized
 * env-file generator (InferenceEnvResolver via AppHelpers) — applies the same
 * floor. Apps not listed have no minimum and keep the pure hardware ladder.
 *
 * hermes-agent: the upstream Hermes Agent fatally rejects a context window below
 * 64K (its MINIMUM_CONTEXT_LENGTH) at startup.
 */
const APP_MIN_CONTEXT_LENGTH: Record<string, number> = {
  'hermes-agent': 64_000,
};

/** The app's minimum context window in tokens, or undefined when it has no floor. */
export function appMinContextLength(slug: string | null | undefined): number | undefined {
  return slug ? APP_MIN_CONTEXT_LENGTH[slug] : undefined;
}
