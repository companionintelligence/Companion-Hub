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

type EmbedderRegistry = Pick<ModelRegistryService, 'getCuratedModel' | 'getRecommendedEmbeddingModel'>;

/**
 * Whether the catalog gives `backend` an embedder to hand out on this hardware — the operator's
 * preference when it runs there, else the tier's recommendation. The test for "this engine embeds
 * for itself" in {@link embeddingBackendFor}; the same lookup {@link pickEmbeddingModel} makes, so
 * an engine judged able to embed is never then found to have nothing.
 */
export function catalogEmbedsOn(
  registry: EmbedderRegistry,
  input: { backend: InferenceBackendType; preferredId?: string | null; profile: HardwareProfile },
): boolean {
  return pickEmbeddingModel(registry, { ...input, served: [] }) != null;
}

/**
 * The engine that embeds for an app, given the chat engine.
 *
 * The chat engine embeds for itself whenever the catalog gives it an embedder (`activeEmbeds`, from
 * {@link catalogEmbedsOn}): one engine then holds one card's budget, the Hub's fit check sees the
 * embedder next to the chat model, and the app's chat host and embed host name the same engine. An
 * engine with no catalog embedder (vLLM, oMLX) borrows a healthy Ollama, and has nothing without one.
 * Both handout paths — the app.env resolver and the bootstrap credentials — decide with this, so an
 * app is never told one embedder by one and another by the other.
 *
 * Until 2026-09-30 a healthy Ollama embedded next to Lemonade instead, to keep Companion Memory's
 * pgvector index on Ollama's 768-dim `nomic-embed-text`. That protected nothing: the Lemonade
 * embedder is the same nomic v1.5 weights (see the catalog row — cosine 0.99996+ on the same text),
 * CI-Server declares both names one embedding generation, and a genuinely different embedder is
 * re-embedded by CI-Server's own stage versioning, not prevented by routing. What the split did do
 * was put two engines that cannot see each other's memory on one card: a Lemonade 27B pinned at boot
 * left Ollama 1.6 GiB, so Ollama ran the embedder — and the chat model an app still asked it for —
 * on the CPU, and the desktop stuttered under 130 % of a core per token.
 *
 * Where nothing embeds (null) the resolver hands out no embedder; the bootstrap credentials keep
 * Ollama's `nomic-embed-text`, as they did before this function existed, because a pool node may
 * serve it. Give oMLX an embedder row before relying on either path there.
 */
export function embeddingBackendFor(
  active: InferenceBackendType,
  input: { activeEmbeds: boolean; ollamaHealthy: boolean },
): InferenceBackendType | null {
  if (input.activeEmbeds) return active;
  if (input.ollamaHealthy) return 'ollama';
  return null;
}

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
