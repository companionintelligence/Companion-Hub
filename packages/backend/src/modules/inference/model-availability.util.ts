import type { CuratedModel } from '@ci-hub/common/types';

/** True when an Ollama tag name matches a catalog model's native backend id. */
export function isOllamaTagForModel(tagName: string, backendModelId: string): boolean {
  if (tagName === backendModelId) return true;
  if (tagName.startsWith(`${backendModelId}:`)) return true;
  if (tagName.startsWith(`${backendModelId}-`)) return true;
  return false;
}

/** True when the model is on disk in Ollama (or tracked as pulled in the registry). */
export function isCuratedModelInstalled(model: CuratedModel, ollamaTags: string[], trackedPulled = false): boolean {
  if (trackedPulled) return true;
  return ollamaTags.some((name) => isOllamaTagForModel(name, model.backendModelId));
}

export function isCatalogModelInstalled(curated: CuratedModel | undefined, ollamaTags: string[], trackedPulled = false): boolean {
  if (!curated) return false;
  return isCuratedModelInstalled(curated, ollamaTags, trackedPulled);
}

/** True when a served model id matches a catalog model's backend id (exact for vLLM/HF ids). */
export function isServedModelForCatalog(model: CuratedModel, servedModelIds: string[]): boolean {
  return servedModelIds.some((id) => id === model.backendModelId);
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
): string[] {
  const installed: string[] = [];
  for (const model of catalog) {
    const trackedState = getTrackedState?.(model.id);
    const trackedPulled = trackedState === 'pulled' || trackedState === 'loaded' || trackedState === 'pinned';
    if (isCuratedModelInstalled(model, ollamaTags, trackedPulled)) {
      installed.push(model.id);
    }
  }
  return installed;
}
