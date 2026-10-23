import type { CuratedModel, InferenceBackendType } from '../types/inference.js';

type ModelRow = Pick<CuratedModel, 'id' | 'backend' | 'modality'>;

/**
 * The chat model the setup wizard marks **Default**, and the one the Hub hands AI apps until someone
 * chooses a model (`InferenceEnvResolver`, `AppCredentialsService`). One rule for both, so a Hub whose
 * wizard never ran (a restore after pairing skips it) runs its apps on the model the wizard would have
 * offered, not on another the Hub picked by itself.
 *
 * ⚠ AMONG `candidateIds`, THE HIGHEST ON THE WIZARD'S RECOMMENDATION LIST, THEN THE FIRST IN CATALOG
 * ORDER. The wizard passes the models that are ticked; the Hub passes the ones the engine has. Taking
 * the first candidate in catalog order alone marked Qwen 3.5 0.8B over the recommended Qwen 3.5 4B,
 * because the catalog lists each family smallest first. A candidate off the list wins only when none
 * is on it. On a 128 GB unified-memory machine the list starts with MiniMax M2 230B, a 61.6 GB load,
 * so that is the Default there once the engine has it; with only Gemma 4 E4B, which is not on that
 * list, Gemma is.
 *
 * With no candidate, the wizard falls back to the best recommended chat model the hardware may run,
 * then the first in the catalog. Both would have to be downloaded, which the wizard then does. A
 * handout never names a model that is not there. When someone unticks the Default, the wizard looks
 * only among the models still ticked. Both pass `candidatesOnly` and get `undefined`.
 */
export function defaultChatModelId<T extends ModelRow>(options: {
  backend: InferenceBackendType;
  /** The catalog rows this hardware may run, in catalog order (the onboarding profile's `availableModels`). */
  availableModels: readonly T[];
  /** Best first (the onboarding profile's `recommendedModels`). Ranks the candidates. With none and no `candidatesOnly`, names the model to download. */
  recommendedModels?: readonly T[];
  /** The models to choose from. */
  candidateIds: readonly string[];
  candidatesOnly?: boolean;
  /** Further limits a candidate, such as to a model an app can use. */
  accept?: (model: T) => boolean;
}): string | undefined {
  const accept = options.accept ?? (() => true);
  const chatHere = (model: T | undefined): model is T =>
    Boolean(model && model.backend === options.backend && model.modality === 'llm' && accept(model));
  const byId = new Map(options.availableModels.map((model) => [model.id, model]));
  // Recommended first, best first, then the catalog. Only a row the hardware may run counts.
  const ranked = [...(options.recommendedModels ?? []), ...options.availableModels];
  const first = (allowed: (id: string) => boolean) => ranked.find((model) => allowed(model.id) && chatHere(byId.get(model.id)))?.id;

  const candidates = new Set(options.candidateIds);
  const fromCandidates = first((id) => candidates.has(id));
  if (fromCandidates || options.candidatesOnly) {
    return fromCandidates;
  }
  return first(() => true);
}
