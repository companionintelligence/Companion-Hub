import type { CuratedModel, InferenceBackendType, ResidencyReport, TrackedModel } from '@ci-hub/common/types';
import { isCatalogModelInstalled, servedIdForCatalogModel } from './model-availability.util';

/**
 * One change to the tracked registry that a residency report justifies.
 *
 * The registry is process-local: it knows the models this Hub pulled, loaded or pinned, and
 * nothing else. An engine loads models on its own too — Lemonade at boot and on the first request
 * for an unloaded model, Ollama on any request — and after a Hub restart the registry is empty
 * while both engines are full. Everything keyed on the registry then reads wrong: the settings
 * page shows a resident model as merely downloaded, hides its Unload button, and a pin of it
 * "adopts" it only when someone pins. Measured 2026-09-30: a Hub rebuilt with the Unload button
 * showed none, because Lemonade had loaded the 27B and the embedder itself.
 */
export interface TrackedResidencyChange {
  catalogId: string;
  /** `loaded` for a resident model the registry did not know; `pulled` for one it thought loaded that is gone. */
  state: 'loaded' | 'pulled';
}

/**
 * What the registry should record so it agrees with what the engines hold, given the catalog and
 * the current tracked entries.
 *
 * - A catalog model resident on its engine and untracked, or tracked as `pulled`, becomes `loaded`.
 * - A model tracked as `loaded` whose engine answered residency and no longer lists it becomes
 *   `pulled` — it is still on disk, just not in memory.
 * - `pinned`, `pulling`, `loading` and `error` entries are left alone: those states are the Hub's
 *   own work in progress, and an engine that cannot answer (`models: null`) says nothing either way.
 *
 * Pure: the endpoint applies the changes and returns the registry.
 */
export function reconcileTrackedWithResidency(input: {
  catalog: readonly CuratedModel[];
  tracked: readonly TrackedModel[];
  residency: ResidencyReport;
}): TrackedResidencyChange[] {
  const changes: TrackedResidencyChange[] = [];
  const trackedById = new Map(input.tracked.map((entry) => [entry.catalogId, entry]));

  for (const backend of input.residency.backends) {
    if (backend.models == null) {
      continue;
    }

    const residentIds = backend.models.map((model) => model.id);

    for (const model of input.catalog) {
      if (model.backend !== backend.backend) {
        continue;
      }

      const resident = servedIdForCatalogModel(model, residentIds) !== null;
      const entry = trackedById.get(model.id);

      if (resident && (entry == null || entry.state === 'pulled')) {
        changes.push({ catalogId: model.id, state: 'loaded' });
      } else if (!resident && entry?.state === 'loaded') {
        changes.push({ catalogId: model.id, state: 'pulled' });
      }
    }
  }

  return changes;
}

/**
 * The catalog ids tracked as `pulled` on `backend` that its `inventory` no longer lists: deleted
 * outside the Hub (`ollama rm`). Nothing else drops such an entry, and the registry is in memory, so
 * until the Hub restarted the models page showed the model as downloaded.
 *
 * `inventory` must be the engine's complete answer, as Ollama's `/api/tags` is (see
 * `trackedPullCounts`). Only `pulled` entries: `pulling`, `loading` and `error` are the Hub's own
 * work in progress, `pinned` is the operator's, and a `loaded` one becomes `pulled` first
 * (`reconcileTrackedWithResidency`) once the engine no longer holds it. Tags match the way the
 * handout matches them (`isCatalogModelInstalled`), so nothing the handout counts as installed is
 * dropped.
 */
export function trackedPullsNotListed(input: {
  catalog: readonly CuratedModel[];
  tracked: readonly TrackedModel[];
  backend: InferenceBackendType;
  inventory: readonly string[];
}): string[] {
  const pulled = new Set(
    input.tracked.filter((entry) => entry.state === 'pulled' && entry.backend === input.backend).map((entry) => entry.catalogId),
  );
  const catalogBackendModelIds = input.catalog.map((model) => model.backendModelId);
  return input.catalog
    .filter((model) => model.backend === input.backend && pulled.has(model.id))
    .filter((model) => !isCatalogModelInstalled(model, [...input.inventory], false, catalogBackendModelIds))
    .map((model) => model.id);
}
