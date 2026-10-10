import type { CuratedModel, InferenceBackendType, TrackedModel } from '@ci-hub/common/types';
import { canonicalModelId } from '@/common/helpers/hub-pool';

/** True when an Ollama tag name matches a catalog model's native backend id. */
export function isOllamaTagForModel(tagName: string, backendModelId: string): boolean {
  if (tagName === backendModelId) return true;
  if (tagName.startsWith(`${backendModelId}:`)) return true;
  if (tagName.startsWith(`${backendModelId}-`)) return true;
  return false;
}

/**
 * Longest-match variant of {@link isOllamaTagForModel}.
 *
 * The suffix tolerance above exists so a quantized pull (`hermes4:70b-q4_K_M`) still
 * counts as the catalog's `hermes4:70b`. It also makes every shorter id a prefix of
 * every longer one that shares its stem, and the catalog now carries such pairs on
 * purpose: `qwen3.8:27b` next to `qwen3.8:27b-mtp-q4_K_M`, `nomic-embed-text` next to
 * `nomic-embed-text-v2-moe`. Measured on a box with only the MTP tag pulled, the plain
 * row reported itself installed too, so Settings → AI showed both rows selected and the
 * env resolver could hand apps a tag that was not on disk.
 *
 * A tag therefore names `backendModelId` only when no OTHER catalog id is a longer
 * match for the same tag. Quant suffixes keep working because no catalog row spells
 * them out; the moment one does, that row wins.
 */
export function isOllamaTagForCatalogModel(tagName: string, backendModelId: string, catalogBackendModelIds: Iterable<string>): boolean {
  if (!isOllamaTagForModel(tagName, backendModelId)) return false;
  for (const other of catalogBackendModelIds) {
    if (other !== backendModelId && other.length > backendModelId.length && isOllamaTagForModel(tagName, other)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the registry's record that the Hub pulled a model still counts it as on disk.
 *
 * Not once Ollama has listed what it holds. The record lives in memory and nothing drops it when
 * the model is deleted outside the Hub (`ollama rm`), so believing it over `/api/tags` handed apps a
 * model that answered every request with a 404 until the Hub restarted. Ollama's health check is
 * that `/api/tags` read, so a healthy answer lists everything on disk. Other engines keep the
 * record: Lemonade answers healthy with an empty list when its model read fails, so a model missing
 * from that list proves nothing.
 *
 * `listedBy` is the engine whose model list the caller holds, or null when that engine could not
 * be asked.
 */
export function trackedPullCounts(tracked: Pick<TrackedModel, 'state' | 'backend'> | undefined, listedBy: InferenceBackendType | null): boolean {
  if (tracked?.state !== 'pulled' && tracked?.state !== 'loaded' && tracked?.state !== 'pinned') return false;
  return !(tracked.backend === 'ollama' && listedBy === 'ollama');
}

/**
 * True when the model is on disk in Ollama (or tracked as pulled in the registry).
 *
 * Pass `catalogBackendModelIds` (every backend id in the curated catalog) wherever the
 * caller has it, so a tag that spells out a more specific catalog row is not also
 * credited to the shorter row — see {@link isOllamaTagForCatalogModel}. Without it the
 * match falls back to the plain prefix rule.
 */
export function isCuratedModelInstalled(
  model: CuratedModel,
  ollamaTags: string[],
  trackedPulled = false,
  catalogBackendModelIds?: Iterable<string>,
): boolean {
  if (trackedPulled) return true;
  // Lemonade names are registry keys, not Ollama tags; a Hub-registered one may be listed as `user.<id>`.
  if (model.backend === 'lemonade' && servedIdForCatalogModel(model, ollamaTags) !== null) return true;
  if (catalogBackendModelIds === undefined) {
    return ollamaTags.some((name) => isOllamaTagForModel(name, model.backendModelId));
  }
  const others = Array.from(catalogBackendModelIds);
  return ollamaTags.some((name) => isOllamaTagForCatalogModel(name, model.backendModelId, others));
}

export function isCatalogModelInstalled(
  curated: CuratedModel | undefined,
  ollamaTags: string[],
  trackedPulled = false,
  catalogBackendModelIds?: Iterable<string>,
): boolean {
  if (!curated) return false;
  return isCuratedModelInstalled(curated, ollamaTags, trackedPulled, catalogBackendModelIds);
}

/**
 * The namespace Lemonade files models registered through `/v1/pull` under (`user.<name>`).
 *
 * Whether it then LISTS such a model with the prefix depends on the version: lemonade-server
 * 10.2.0, the apt package every fleet Lemonade node runs, keys and lists it only as `user.<name>`
 * and answers the bare name with "Model not found"; 10.3.0 lists it bare only when it carries the
 * `appear-builtin` label; 2026.39.1 lists it bare. The prefixed name resolves on every one of them.
 */
export const LEMONADE_USER_NAMESPACE = 'user.';

/** `modelId` without {@link LEMONADE_USER_NAMESPACE}: the one spelling both of Lemonade's names for a model share. */
export function withoutLemonadeUserNamespace(modelId: string): string {
  return modelId.startsWith(LEMONADE_USER_NAMESPACE) ? modelId.slice(LEMONADE_USER_NAMESPACE.length) : modelId;
}

/**
 * One spelling per model on `backend`, for matching what an engine reports resident against the
 * registry and the catalog, which carry the catalog's `backendModelId`.
 *
 * Every engine folds Ollama's `name` ≡ `name:latest` ({@link canonicalModelId}): `/api/ps` names the
 * catalog's `nomic-embed-text` `nomic-embed-text:latest`. Lemonade also folds its `user.` namespace:
 * 10.2.0 lists the embedder the Hub registers as `user.nomic-embed-text-v1.5-GGUF` while the catalog
 * row says `nomic-embed-text-v1.5-GGUF`, and an exact match there let an operator's load evict that
 * embedder although it was pinned. Only Lemonade: `user.` means nothing to any other engine.
 */
export function engineModelKey(backend: InferenceBackendType, modelId: string): string {
  return canonicalModelId(backend === 'lemonade' ? withoutLemonadeUserNamespace(modelId) : modelId);
}

/** Whether `a` and `b` name one model on `backend`, under {@link engineModelKey}'s folding. */
export function sameEngineModelId(backend: InferenceBackendType, a: string, b: string): boolean {
  return a === b || engineModelKey(backend, a) === engineModelKey(backend, b);
}

/**
 * The spelling under which `servedModelIds` names a catalog model, or null when it does not.
 *
 * Exact for every engine. A Lemonade row also answers to `user.<backendModelId>`, the name a
 * Lemonade older than the bare public aliases lists a Hub-registered model under — without this the
 * Hub never saw the embedder it had just registered as installed, and handed apps a bare name the
 * server rejected.
 */
export function servedIdForCatalogModel(model: CuratedModel, servedModelIds: Iterable<string>): string | null {
  const served = new Set(servedModelIds);
  if (served.has(model.backendModelId)) return model.backendModelId;
  if (model.backend === 'lemonade') {
    const namespaced = `${LEMONADE_USER_NAMESPACE}${model.backendModelId}`;
    if (served.has(namespaced)) return namespaced;
  }
  return null;
}

/** True when a served model id matches a catalog model's backend id (exact for vLLM/HF ids; see {@link servedIdForCatalogModel}). */
export function isServedModelForCatalog(model: CuratedModel, servedModelIds: string[]): boolean {
  return servedIdForCatalogModel(model, servedModelIds) !== null;
}

/** Map live served model ids to catalog ids for models on the given backend. */
export function resolveInstalledCatalogIdsFromServedModels(
  catalog: CuratedModel[],
  servedModelIds: string[],
  backend: CuratedModel['backend'],
  getTrackedState?: (catalogId: string) => string | undefined,
): string[] {
  const installed: string[] = [];
  for (const model of catalog) {
    if (model.backend !== backend) {
      continue;
    }

    const trackedState = getTrackedState?.(model.id);
    const trackedPulled = trackedState === 'pulled' || trackedState === 'loaded' || trackedState === 'pinned';
    if (trackedPulled || isServedModelForCatalog(model, servedModelIds)) {
      installed.push(model.id);
    }
  }
  return installed;
}

/** Map live Ollama tag names to catalog ids for models in the given catalog slice. */
export function resolveInstalledCatalogIds(
  catalog: CuratedModel[],
  ollamaTags: string[],
  getTrackedState?: (catalogId: string) => string | undefined,
  // The ids a longer match is looked for in. Defaults to the slice itself; pass the
  // full catalog's ids when `catalog` is a filtered slice, so a row filtered out of
  // the slice still keeps its tag away from a shorter row that survived the filter.
  catalogBackendModelIds: Iterable<string> = catalog.map((model) => model.backendModelId),
): string[] {
  const installed: string[] = [];
  const others = Array.from(catalogBackendModelIds);
  for (const model of catalog) {
    const trackedState = getTrackedState?.(model.id);
    const trackedPulled = trackedState === 'pulled' || trackedState === 'loaded' || trackedState === 'pinned';
    if (isCuratedModelInstalled(model, ollamaTags, trackedPulled, others)) {
      installed.push(model.id);
    }
  }
  return installed;
}
