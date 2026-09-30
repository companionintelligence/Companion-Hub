import type { CuratedModel, HardwareProfile, InferenceBackendType } from '@ci-hub/common/types';
import type { InferenceBackend } from './backends/backend.interface';
import { servedIdForCatalogModel } from './model-availability.util';
import type { ModelRegistryService } from './model-registry.service';

/**
 * Lemonade's built-in nomic v1 embedder, the Hub's Lemonade default until 2026-09-29. A host that
 * embedded with it holds v1 vectors, which v1.5 (the default since) cannot search; see
 * {@link pickEmbeddingModel}.
 */
export const LEMONADE_V1_EMBEDDER_ID = 'nomic-embed-text-v1-lemonade';

/**
 * The engine that embeds for an app, given the chat engine and whether a local Ollama is healthy.
 *
 * Ollama and oMLX embed for themselves. Next to vLLM or Lemonade a healthy Ollama embeds (Companion
 * Memory's pgvector index is built on Ollama's 768-dim `nomic-embed-text`); a Lemonade with no
 * Ollama embeds itself, through the Ollama-compatible `/api/embed` it serves. vLLM with no Ollama
 * has nothing: the catalog ships no vLLM embedder. Both handout paths — the app.env resolver and the
 * bootstrap credentials — decide with this, so an app is never told one embedder by one and another
 * by the other.
 */
export function embeddingBackendFor(active: InferenceBackendType, ollamaHealthy: boolean): InferenceBackendType | null {
  if (active === 'ollama' || active === 'omlx') return active;
  if (ollamaHealthy) return 'ollama';
  if (active === 'lemonade') return 'lemonade';
  return null;
}

type EmbedderRegistry = Pick<ModelRegistryService, 'getCuratedModel' | 'getRecommendedEmbeddingModel'>;

/**
 * The catalog embedder to hand out on `backend`: the operator's preference when it runs there, else
 * the tier's recommendation — except that a Lemonade host which has v1 downloaded and not the
 * recommended v1.5 stays on v1. Both are 768-dim, so pgvector would take v1.5 vectors into a v1
 * index without complaint and search would quietly return worse matches; moving that host to v1.5
 * is a re-embed the operator chooses (by preferring the v1.5 row), not a side effect of an upgrade.
 */
export function pickEmbeddingModel(
  registry: EmbedderRegistry,
  input: { backend: InferenceBackendType; preferredId?: string | null; profile: HardwareProfile; served: readonly string[] },
): CuratedModel | null {
  if (input.preferredId) {
    const preferred = registry.getCuratedModel(input.preferredId);
    if (preferred?.backend === input.backend) return preferred;
  }
  const recommended = registry.getRecommendedEmbeddingModel(input.profile.tier, input.backend, input.profile);
  if (input.backend === 'lemonade' && recommended) {
    const v1 = registry.getCuratedModel(LEMONADE_V1_EMBEDDER_ID);
    if (v1 && v1.id !== recommended.id && servedIdForCatalogModel(v1, input.served) && !servedIdForCatalogModel(recommended, input.served)) {
      return v1;
    }
  }
  return recommended;
}

/**
 * The id an app must send for `model`: the spelling the engine lists it under, else the engine's own
 * name for it (`engineModelId`), else the catalog id. Lemonade 10.2.0 lists a Hub-registered embedder
 * only as `user.<id>` and answers the bare id with "Model not found", so handing out the catalog id
 * left Memory unable to embed anything on a Lemonade-only host. An Ollama tag is always the catalog id:
 * `servedIdForCatalogModel` matches exactly, so Ollama's `nomic-embed-text:latest` never replaces the
 * `nomic-embed-text` every app has been handed.
 */
export function embedderEngineId(model: CuratedModel, served: readonly string[], engine?: InferenceBackend): string {
  return servedIdForCatalogModel(model, served) ?? engine?.engineModelId?.(model.backendModelId) ?? model.backendModelId;
}
