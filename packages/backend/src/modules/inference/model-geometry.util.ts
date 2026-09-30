/**
 * Per-token KV-cache cost of a model, from what Ollama itself reports.
 *
 * The context ladder in `context-length.util.ts` used to assume every model costs the same per
 * token of context, about 4 GB per doubling — dense-70B arithmetic. A hybrid-attention 27B (Qwen
 * 3.5/3.8: Gated DeltaNet with a full-attention layer every fourth block, 4 KV heads) costs about a
 * fifth of that, so the ladder handed it half the window its card could carry; a dense model with
 * many KV heads could be handed more than fits. `GET /api/show` exposes the geometry that decides
 * this, and `GET /api/ps` exposes what a loaded model actually occupies, which corrects for the
 * fields the JSON API drops.
 *
 * Ported from CI-Server's `domains/llm/residency/footprint.ts` (same org, same measurements): the
 * two must agree, because CI-Server falls back to the same math when the Hub sends no window.
 */

export const KV_BYTES_PER_ELEMENT = 2; // f16 KV cache, Ollama's default
const MIB = 1024 ** 2;

/** Measured on the boxes the estimator was built from: what a runner holds above weights + KV. */
export const FIXED_RUNNER_OVERHEAD_MB = 768;

/**
 * When a live sighting exists, its per-token cost is scaled by this before being trusted: the
 * sighting was taken at one window, and llama.cpp's scratch grows a little faster than linearly.
 */
export const OBSERVATION_SAFETY_FACTOR = 1.5;

export interface ModelGeometry {
  architecture: string;
  blockCount: number;
  headCount: number;
  /**
   * `attention.head_count_kv`. Some models (qwen3.5, qwen3.6) publish this as a per-layer array,
   * which the JSON API drops; null then, and {@link kvBytesPerToken} falls back to `headCount`
   * (an over-estimate — the safe direction; a sighting corrects it).
   */
  headCountKv: number | null;
  keyLength: number;
  valueLength: number;
  trainingContextLength: number | null;
  /** gemma4: layers that share a KV cache with another and own none of their own. */
  sharedKvLayers: number;
  /** qwen3.5/3.8: only every Nth block is full attention; the rest keep a fixed-size state. */
  fullAttentionInterval: number | null;
}

type ModelInfo = Map<string, unknown> | Record<string, unknown>;

function infoValue(info: ModelInfo, key: string): unknown {
  return info instanceof Map ? info.get(key) : info[key];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** The attention geometry under `/api/show`'s `model_info`, or null when it is not readable. */
export function parseModelGeometry(modelInfo: ModelInfo | null | undefined): ModelGeometry | null {
  if (!modelInfo) return null;
  const architecture = infoValue(modelInfo, 'general.architecture');
  if (typeof architecture !== 'string' || architecture.length === 0) return null;
  const read = (suffix: string) => infoValue(modelInfo, `${architecture}.${suffix}`);
  const blockCount = positiveInteger(read('block_count'));
  const headCount = positiveInteger(read('attention.head_count'));
  if (blockCount == null || headCount == null) return null;
  const embeddingLength = positiveInteger(read('embedding_length'));
  const derivedHeadDim = embeddingLength == null ? null : Math.ceil(embeddingLength / headCount);
  const keyLength = positiveInteger(read('attention.key_length')) ?? derivedHeadDim;
  const valueLength = positiveInteger(read('attention.value_length')) ?? keyLength;
  if (keyLength == null || valueLength == null) return null;
  return {
    architecture,
    blockCount,
    headCount,
    headCountKv: positiveInteger(read('attention.head_count_kv')),
    keyLength,
    valueLength,
    trainingContextLength: positiveInteger(read('context_length')),
    sharedKvLayers: positiveInteger(read('attention.shared_kv_layers')) ?? 0,
    fullAttentionInterval: positiveInteger(read('full_attention_interval')),
  };
}

/**
 * f16 KV-cache bytes per token of context, summed over the layers that own a full-attention KV
 * cache. Sliding-window layers are counted at full size: the API does not say which layers slide,
 * and counting them all as global is the conservative reading.
 */
export function kvBytesPerToken(geometry: ModelGeometry): number {
  const kvHeads = geometry.headCountKv ?? geometry.headCount;
  let layers = Math.max(1, geometry.blockCount - geometry.sharedKvLayers);
  if (geometry.fullAttentionInterval != null && geometry.fullAttentionInterval > 1) {
    layers = Math.ceil(layers / geometry.fullAttentionInterval);
  }
  return layers * kvHeads * (geometry.keyLength + geometry.valueLength) * KV_BYTES_PER_ELEMENT;
}

/** What `/api/ps` said about this model while it was loaded. */
export interface ResidentSighting {
  contextLength: number;
  vramBytes: number;
}

export interface ContextCostInput {
  geometry: ModelGeometry | null;
  /** From `/api/tags` (`size`): the weights on disk, which is what the runner maps. */
  weightBytes: number | null;
  sighting?: ResidentSighting | null;
}

export interface ContextCost {
  /** MB of memory one token of context costs, for the ladder to multiply. */
  kvMbPerToken: number;
  weightMb: number | null;
  /** `catalog`: the catalog's measured `kvMbPerToken` (see `context-cost.util`), for an engine that cannot say. */
  source: 'geometry' | 'calibrated' | 'catalog';
}

/**
 * The per-token cost the ladder should charge, from the geometry and, when the model is loaded, from
 * what it actually occupies. The smaller of the two wins: the formula over-estimates whenever the
 * API dropped `head_count_kv`, and a sighting is the ground truth for that model on this engine.
 * A sighting whose VRAM is not above the weights (Ollama reports `size_vram` below the file size
 * for some quantizations) carries no information about context and is ignored.
 */
export function estimateContextCost({ geometry, weightBytes, sighting }: ContextCostInput): ContextCost | null {
  const weightMb = weightBytes != null && weightBytes > 0 ? weightBytes / MIB : null;
  const formulaMb = geometry ? kvBytesPerToken(geometry) / MIB : null;

  let calibratedMb: number | null = null;
  if (sighting && sighting.contextLength > 0 && weightBytes != null && weightBytes > 0) {
    const dynamicBytes = sighting.vramBytes - weightBytes - FIXED_RUNNER_OVERHEAD_MB * MIB;
    if (dynamicBytes > 0) {
      calibratedMb = ((dynamicBytes / sighting.contextLength) * OBSERVATION_SAFETY_FACTOR) / MIB;
    }
  }

  if (formulaMb == null && calibratedMb == null) return null;
  if (formulaMb != null && calibratedMb != null) {
    return { kvMbPerToken: Math.min(formulaMb, calibratedMb), weightMb, source: calibratedMb < formulaMb ? 'calibrated' : 'geometry' };
  }
  return formulaMb == null
    ? { kvMbPerToken: calibratedMb as number, weightMb, source: 'calibrated' }
    : { kvMbPerToken: formulaMb, weightMb, source: 'geometry' };
}
