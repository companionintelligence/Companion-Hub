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
}

const FALLBACK_CONTEXT = 8192;
const FLOOR_CONTEXT = 4096;

/** Returns a hardware-appropriate num_ctx in tokens, never exceeding the model's window. */
export function recommendContextLength(input: ContextLengthInput): number {
  const { effectiveInferenceMemoryMb, modelFootprintMb, modelContextWindow } = input;
  const cap = modelContextWindow > 0 ? modelContextWindow : FALLBACK_CONTEXT;

  if (!Number.isFinite(effectiveInferenceMemoryMb) || effectiveInferenceMemoryMb <= 0) {
    return Math.min(FALLBACK_CONTEXT, cap);
  }

  const freeForContextMb = effectiveInferenceMemoryMb - Math.max(0, modelFootprintMb || 0);

  let ladder: number;
  if (freeForContextMb >= 16384) ladder = 65536;
  else if (freeForContextMb >= 8192) ladder = 32768;
  else if (freeForContextMb >= 4096) ladder = 16384;
  else if (freeForContextMb >= 2048) ladder = 8192;
  else ladder = FLOOR_CONTEXT;

  return Math.min(ladder, cap);
}
