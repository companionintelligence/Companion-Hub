import { appInferenceRequirements } from './app-inference-requirements';

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
 * Two ways to size it:
 *
 * - **Measured**, when the caller passes `kvMbPerToken` (from `model-geometry.util`, i.e. from
 *   Ollama's `/api/show` and `/api/ps`): the largest power-of-two window whose KV cache fits in
 *   what is left after the weights, a fixed runner overhead and a safety margin. This is
 *   model-specific — a hybrid-attention 27B costs a fifth per token of a dense one.
 * - **Ladder**, otherwise: a fixed 2/4/8/16 GB → 8k/16k/32k/64k heuristic that assumes dense-70B
 *   KV arithmetic. Intentionally conservative; it mirrors the ladder used by CI-OS's host-side
 *   `recommend_ollama_context_length`, and it is what non-Ollama backends still get.
 *
 * Neither path exceeds 64k on its own: above that, `minContextLength` (an app's declared floor)
 * is the only thing that raises the answer, and the model window always caps it.
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
  /**
   * Measured per-token KV cost in MB (see `estimateContextCost`). When present and positive, the
   * measured path replaces the ladder. Null/absent keeps the ladder.
   */
  kvMbPerToken?: number | null;
  /**
   * The weights' size in MB when known (from `/api/tags`). The measured path charges
   * `max(modelFootprintMb, weightMb + MEASURED_FIXED_OVERHEAD_MB)` before any context, so a catalog
   * footprint that already includes headroom is never undercut by a smaller measured base.
   */
  weightMb?: number | null;
  /**
   * MB to keep free for a vision encoder's buffers ({@link VISION_ENCODER_RESERVE_MB} for a model
   * that takes images, else 0). Charged on both paths, before any context.
   */
  visionReserveMb?: number;
}

const FALLBACK_CONTEXT = 8192;
const FLOOR_CONTEXT = 4096;
/** Highest window either path chooses unprompted; an app floor may still raise it. */
const MAX_UNPROMPTED_CONTEXT = 65536;
/** What a runner holds above weights + KV; mirrors `model-geometry.util`. */
const MEASURED_FIXED_OVERHEAD_MB = 768;
/**
 * Kept free on the measured path for what neither the weights nor the KV cache account for: a
 * vision encoder's compute buffers, llama.cpp scratch, a second small model. Measured 2026-09-17:
 * a 27B at 32k reported 16.2 GiB by `/api/ps` while the card showed 22.5 GiB in use.
 */
const MEASURED_SAFETY_MARGIN_MB = 1024;

/**
 * What the ladder assumes one token of context costs: each rung doubles the window for each
 * doubling of free memory, starting from 8192 tokens in 2048 MB.
 */
export const LADDER_KV_MB_PER_TOKEN = 2048 / 8192;

/**
 * What a model occupies once loaded at `numCtx`, by the same arithmetic
 * {@link recommendContextLength} used to choose that window: the base it charged, the KV cache at
 * the chosen window, and — on the measured path — the margin it kept free. The fit check before a
 * load compares this, not the catalog footprint, against free memory: the catalog figure is the
 * weights, and a load at a large window can be half as big again.
 */
export function estimateLoadedFootprintMb(input: {
  modelFootprintMb: number;
  numCtx: number;
  kvMbPerToken?: number | null;
  weightMb?: number | null;
  visionReserveMb?: number;
}): number {
  const { modelFootprintMb, numCtx, kvMbPerToken, weightMb } = input;
  const footprint = Math.max(0, modelFootprintMb || 0);
  if (typeof kvMbPerToken === 'number' && Number.isFinite(kvMbPerToken) && kvMbPerToken > 0) {
    const measuredBase = typeof weightMb === 'number' && weightMb > 0 ? weightMb + MEASURED_FIXED_OVERHEAD_MB : 0;
    return Math.ceil(Math.max(footprint, measuredBase) + numCtx * kvMbPerToken + MEASURED_SAFETY_MARGIN_MB + visionReserve(input));
  }
  return Math.ceil(footprint + numCtx * LADDER_KV_MB_PER_TOKEN + visionReserve(input));
}

/**
 * Kept free for a vision model's image encoder, whose buffers are allocated on the first image rather
 * than at load — so a load-time fit check never sees them, and a window sized without them spills
 * once an app sends a picture. Measured 2026-09-29, Qwen 3.8 27B on Lemonade: 513–560 MiB for a
 * 1280×960 image (1,256 image tokens, CI-Server's rendition limit), 1,046 MiB for 2560×1920 (4,071
 * tokens) — about 300 MiB plus 0.18 MiB per image token. This covers the larger of the two.
 */
export const VISION_ENCODER_RESERVE_MB = 1024;

function visionReserve(input: { visionReserveMb?: number }): number {
  const mb = input.visionReserveMb;
  return typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? mb : 0;
}

/** Powers of two from the cap down to the floor: the candidates the measured path walks. */
function measuredCandidates(cap: number): number[] {
  const out: number[] = [];
  for (let window = MAX_UNPROMPTED_CONTEXT; window >= FLOOR_CONTEXT; window /= 2) {
    if (window <= cap) out.push(window);
  }
  return out;
}

/** Returns a hardware-appropriate num_ctx in tokens, never exceeding the model's window. */
export function recommendContextLength(input: ContextLengthInput): number {
  const { effectiveInferenceMemoryMb, modelFootprintMb, modelContextWindow, minContextLength } = input;
  // Floor the model window so a fractional registry value can't yield a fractional
  // num_ctx; the ladder constants are already integers.
  const cap = Math.floor(modelContextWindow > 0 ? modelContextWindow : FALLBACK_CONTEXT);
  // App-specific floor, never raised above what the model can actually serve.
  // Guard against a non-finite minContextLength (NaN/Infinity) so a bad caller
  // input can never poison the Math ops; floor it so a fractional minimum (e.g.
  // 64000.5) can't produce a fractional, invalid token count.
  const requestedFloor = Number.isFinite(minContextLength) ? Math.floor(minContextLength as number) : 0;
  const floor = Math.min(Math.max(0, requestedFloor), cap);

  if (!Number.isFinite(effectiveInferenceMemoryMb) || effectiveInferenceMemoryMb <= 0) {
    return Math.min(Math.max(FALLBACK_CONTEXT, floor), cap);
  }

  const { kvMbPerToken, weightMb } = input;
  if (typeof kvMbPerToken === 'number' && Number.isFinite(kvMbPerToken) && kvMbPerToken > 0) {
    const measuredBase = typeof weightMb === 'number' && weightMb > 0 ? weightMb + MEASURED_FIXED_OVERHEAD_MB : 0;
    const baseMb = Math.max(0, modelFootprintMb || 0, measuredBase);
    const budgetMb = effectiveInferenceMemoryMb - baseMb - MEASURED_SAFETY_MARGIN_MB - visionReserve(input);
    const fit = measuredCandidates(cap).find((window) => window * kvMbPerToken <= budgetMb) ?? FLOOR_CONTEXT;
    return Math.min(Math.max(fit, floor), cap);
  }

  const freeForContextMb = effectiveInferenceMemoryMb - Math.max(0, modelFootprintMb || 0) - visionReserve(input);

  let ladder: number;
  if (freeForContextMb >= 16384) ladder = 65536;
  else if (freeForContextMb >= 8192) ladder = 32768;
  else if (freeForContextMb >= 4096) ladder = 16384;
  else if (freeForContextMb >= 2048) ladder = 8192;
  else ladder = FLOOR_CONTEXT;

  return Math.min(Math.max(ladder, floor), cap);
}

/**
 * The app's minimum context window in tokens, or undefined when it has no floor.
 *
 * Every Hub code path that sizes an app's context — the `credentials.env` endpoint
 * (AppCredentialsService) and the env-file generator (InferenceEnvResolver via AppHelpers) — reads
 * the same floor. The table lives in `app-inference-requirements.ts`, beside the tool-calling
 * requirement, because a floor the model cannot reach has to be checked where the model is chosen.
 */
export function appMinContextLength(slug: string | null | undefined): number | undefined {
  const min = appInferenceRequirements(slug).minContextLength;
  return typeof min === 'number' ? min : undefined;
}
