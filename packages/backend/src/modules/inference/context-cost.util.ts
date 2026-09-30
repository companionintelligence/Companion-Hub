import type { CuratedModel } from '@ci-hub/common/types';
import type { InferenceBackend } from './backends/backend.interface';
import type { ContextCost } from './model-geometry.util';

/**
 * What a token of context costs `model` on `backend`, from the best source there is: the engine's
 * own measurement (Ollama's geometry and sightings) and the catalog's measured `kvMbPerToken`,
 * the smaller winning when both exist — both are biased high, and Ollama's formula over-estimates
 * several-fold whenever `/api/show` drops a per-layer `head_count_kv`. Weights come from the engine:
 * Ollama's `/api/tags`, or the files Lemonade lists. Null when neither can say, and the context
 * ladder then keeps its fixed assumption.
 *
 * Only meaningful for a model this node serves; a peer's engine cannot be asked from here.
 * Never throws: a probe that fails costs only the measurement.
 */
export async function probeContextCost(backend: InferenceBackend, model: CuratedModel): Promise<ContextCost | null> {
  const measured = await Promise.resolve(backend.contextCostForModel?.(model.backendModelId) ?? null).catch(() => null);
  const catalogKv = model.runtime.kvMbPerToken;
  if (typeof catalogKv !== 'number' || !Number.isFinite(catalogKv) || catalogKv <= 0) {
    return measured;
  }
  if (measured) {
    return catalogKv < measured.kvMbPerToken ? { ...measured, kvMbPerToken: catalogKv, source: 'catalog' } : measured;
  }
  const weightMb = await Promise.resolve(backend.weightsOnDiskMb?.(model.backendModelId) ?? null).catch(() => null);
  return { kvMbPerToken: catalogKv, weightMb, source: 'catalog' };
}
