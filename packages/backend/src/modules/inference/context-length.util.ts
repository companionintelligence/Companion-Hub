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
 *
 * A **sighting** — what this node's engine was measured holding for the model at a known window —
 * replaces the catalog and file-size base on either path when there is one; see
 * {@link FootprintSighting}.
 */

/**
 * What this node's engine was seen holding for a model, at the window it was loaded at: the ground
 * truth that the catalog footprint and the file size only approximate.
 *
 * Both approximations can be far off. gemma4:e4b's catalog row says 10,813 MB and its file 9,163 MiB
 * (per-layer embeddings and the audio and vision towers included), while beta-red's RTX 3080 served
 * it on 2026-09-29 at a 16384 window with four slots in 5,550 MiB (nvidia-smi) — `/api/ps` said
 * 3,209. Sized from the catalog, the Hub refused to pin or load it on the 8 and 10 GB cards it was
 * running on at that moment. `MemoryManagerService` records these as it measures its budget.
 */
export interface FootprintSighting {
  /** MB the model occupied, in the budget's own units: see {@link source}. */
  footprintMb: number;
  /** The per-sequence window it was loaded at (`/api/ps` `context_length`), in tokens. */
  contextLength: number;
  /**
   * `process`: the engine process as nvidia-smi / rocm-smi measured it, which counts the runtime
   * context and compute buffers the engine's own figure leaves out. `engine`: the engine's own
   * figure (`/api/ps`), which does not, so the safety margin is still charged on top of it.
   */
  source: 'process' | 'engine';
}

/** What a model occupies once loaded: every input the estimate and the recommendation share. */
export interface ModelMemoryInput {
  /** Approximate resident size of the model's weights, in MB. */
  modelFootprintMb: number;
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
  /**
   * How many sequences the engine allocates a KV cache for: Ollama sizes its runner at
   * `num_ctx × OLLAMA_NUM_PARALLEL` (`server/sched.go`, `effectiveLlamaServerContext`), so on the
   * fleet's four-slot nodes a window costs four times its per-token price. Absent or not a positive
   * integer is one. Callers leave it at one for a cost already measured across every slot (a
   * sighting-calibrated one) and for the families Ollama forces to a single slot.
   */
  kvSlots?: number | null;
  /** What this node's engine was seen holding for the model, which replaces the base when present. */
  sighting?: FootprintSighting | null;
}

export interface ContextLengthInput extends ModelMemoryInput {
  /**
   * Memory one model may use on this node, in MB: `MemoryManagerService.modelMemoryCeilingMb`, the
   * budget a load is fit-checked against with nothing else loaded. Sizing against the whole card
   * instead (`HardwareProfile.effectiveInferenceMemoryMb`) picked windows the fit check then refused
   * on an empty card.
   */
  effectiveInferenceMemoryMb: number;
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
/** The smallest window either path chooses, and where the load path's step-down stops. */
export const FLOOR_CONTEXT = 4096;
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
 * the chosen window for every slot, and — on the measured path — the margin it kept free. The fit
 * check before a load compares this, not the catalog footprint, against free memory: the catalog
 * figure is the weights, and a load at a large window can be half as big again.
 *
 * With a {@link FootprintSighting} the base is what the engine was seen holding, and only the KV
 * cache above the sighted window is added. A window below the sighting is charged the sighting
 * itself, never less: the per-token cost is an estimate (gemma4's geometry counts its 512-token
 * sliding-window layers as global, about ten times what core-7 measured), and subtracting an
 * over-estimate would let a load through on memory the model really needs.
 */
export function estimateLoadedFootprintMb(input: ModelMemoryInput & { numCtx: number }): number {
  const { modelFootprintMb, numCtx, weightMb } = input;
  const measuredKv = measuredKvMbPerToken(input);
  const perToken = (measuredKv ?? LADDER_KV_MB_PER_TOKEN) * kvSlots(input);
  const sighting = usableSighting(input);
  if (sighting) {
    const margin = sighting.source === 'process' ? 0 : MEASURED_SAFETY_MARGIN_MB;
    return Math.ceil(sighting.footprintMb + Math.max(0, numCtx - sighting.contextLength) * perToken + margin + visionReserve(input));
  }
  const footprint = Math.max(0, modelFootprintMb || 0);
  if (measuredKv !== null) {
    const measuredBase = typeof weightMb === 'number' && weightMb > 0 ? weightMb + MEASURED_FIXED_OVERHEAD_MB : 0;
    return Math.ceil(Math.max(footprint, measuredBase) + numCtx * perToken + MEASURED_SAFETY_MARGIN_MB + visionReserve(input));
  }
  return Math.ceil(footprint + numCtx * perToken + visionReserve(input));
}

/**
 * The largest window from `from` down to {@link FLOOR_CONTEXT}, halving each step (65536 → 32768 →
 * … → 4096, with `from` itself tried first when it is not a power of two, e.g. Hermes' 64000), whose
 * {@link estimateLoadedFootprintMb} fits in `budgetMb`. Null when not even the floor fits.
 *
 * The step-down before a load refuses or evicts: a 27B sized at 32768 on an empty 24 GiB card
 * (24,371 MB against a 24,048 MB budget) was refused outright although 16384 (23,347 MB) fits.
 */
export function largestFittingWindow(input: ModelMemoryInput & { from: number; budgetMb: number }): number | null {
  const from = Math.floor(input.from);
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(input.budgetMb)) return null;
  const candidates = [from];
  let power = 2 ** Math.floor(Math.log2(from));
  if (power === from) power /= 2;
  for (; power >= FLOOR_CONTEXT; power /= 2) candidates.push(power);
  return candidates.find((numCtx) => estimateLoadedFootprintMb({ ...input, numCtx }) <= input.budgetMb) ?? null;
}

function measuredKvMbPerToken(input: { kvMbPerToken?: number | null }): number | null {
  const kv = input.kvMbPerToken;
  return typeof kv === 'number' && Number.isFinite(kv) && kv > 0 ? kv : null;
}

function kvSlots(input: { kvSlots?: number | null }): number {
  const slots = input.kvSlots;
  return typeof slots === 'number' && Number.isInteger(slots) && slots > 1 ? slots : 1;
}

function usableSighting(input: { sighting?: FootprintSighting | null }): FootprintSighting | null {
  const sighting = input.sighting;
  if (!sighting) return null;
  const { footprintMb, contextLength } = sighting;
  return Number.isFinite(footprintMb) && footprintMb > 0 && Number.isFinite(contextLength) && contextLength > 0 ? sighting : null;
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

  // The measured path and the estimate a load is fit-checked with are one arithmetic, so a window
  // chosen here is a window that load fits by construction.
  if (measuredKvMbPerToken(input) !== null || usableSighting(input) !== null) {
    const fit =
      measuredCandidates(cap).find((window) => estimateLoadedFootprintMb({ ...input, numCtx: window }) <= effectiveInferenceMemoryMb) ??
      FLOOR_CONTEXT;
    return Math.min(Math.max(fit, floor), cap);
  }

  // The ladder's rungs are per sequence; a node running N slots has 1/N of the free memory for each.
  const freeForContextMb = (effectiveInferenceMemoryMb - Math.max(0, modelFootprintMb || 0) - visionReserve(input)) / kvSlots(input);

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
