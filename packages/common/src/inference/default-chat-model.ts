import type { CuratedModel, InferenceBackendType } from '../types/inference.js';

type ModelRow = Pick<CuratedModel, 'id' | 'backend' | 'modality'>;

/**
 * The chat model the setup wizard marks **Default**, and the one the Hub hands AI apps until someone
 * chooses a model (`InferenceEnvResolver`, `AppCredentialsService`). One rule for both, so a Hub whose
 * wizard never ran (a restore after pairing skips it) runs its apps on the model the wizard would have
 * offered, not on another the Hub picked by itself.
 *
 * ⚠ THE FIRST CHAT MODEL IN `candidateIds`, IN THAT ORDER. The wizard passes the models that are
 * ticked, which at first are the ones the engine has, in catalog order; the Hub passes the ones the
 * engine has. The recommendation list ranks by capability, and on a 128 GB unified-memory machine it
 * starts with MiniMax M2 230B, a 61.6 GB load, while the wizard marked Gemma 4 E4B. Restored apps ran
 * on MiniMax until the wizard saved a model, and with the wizard skipped they would have kept it.
 *
 * With no candidate, the wizard falls back to the best recommended chat model the hardware may run,
 * then the first in the catalog. Both would have to be downloaded, which the wizard then does; a
 * handout never names a model that is not there, so it passes `installedOnly` and gets `undefined`.
 */
export function defaultChatModelId<T extends ModelRow>(options: {
  backend: InferenceBackendType;
  /** The catalog rows this hardware may run, in catalog order (the onboarding profile's `availableModels`). */
  availableModels: readonly T[];
  /** Best first (the onboarding profile's `recommendedModels`). Unused with `installedOnly`. */
  recommendedModels?: readonly T[];
  /** The models to choose from first, in order. */
  candidateIds: readonly string[];
  installedOnly?: boolean;
  /** Further limits a candidate, such as to a model an app can use. */
  accept?: (model: T) => boolean;
}): string | undefined {
  const accept = options.accept ?? (() => true);
  const chatHere = (model: T | undefined): model is T =>
    Boolean(model && model.backend === options.backend && model.modality === 'llm' && accept(model));
  const byId = new Map(options.availableModels.map((model) => [model.id, model]));

  const fromCandidates = options.candidateIds.find((id) => chatHere(byId.get(id)));
  if (fromCandidates || options.installedOnly) {
    return fromCandidates;
  }

  const runnable = new Set(options.availableModels.filter(chatHere).map((model) => model.id));
  return (
    (options.recommendedModels ?? []).find((model) => chatHere(model) && runnable.has(model.id))?.id ?? options.availableModels.find(chatHere)?.id
  );
}
