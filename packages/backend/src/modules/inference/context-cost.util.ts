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
 * The weights' size is dropped for a model whose catalog footprint was measured
 * (`runtime.footprintMeasured`). Context sizing charges the larger of that footprint and the file
 * plus runner overhead, and a file is no floor for such a model: gemma4:e4b's is 9,163 MiB, while
 * its weights, encoders and runtime hold 4,046-4,357 MiB, so the file would put back the refusal the
 * measurement fixed.
 *
 * Only meaningful for a model this node serves; a peer's engine cannot be asked from here.
 * Never throws: a probe that fails costs only the measurement.
 */
export async function probeContextCost(backend: InferenceBackend, model: CuratedModel): Promise<ContextCost | null> {
  const cost = await probeEngineAndCatalog(backend, model);
  return cost && model.runtime.footprintMeasured ? { ...cost, weightMb: null } : cost;
}

async function probeEngineAndCatalog(backend: InferenceBackend, model: CuratedModel): Promise<ContextCost | null> {
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
