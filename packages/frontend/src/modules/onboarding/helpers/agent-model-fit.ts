import { type CuratedModel, defaultChatModelId, type InferenceBackendType, smallestDownload } from '@ci-hub/common/types';
import type { AgentFramework } from './ai-setup-types';

/** The context window Hermes refuses to start below (the backend's `app-inference-requirements.ts`). */
export const HERMES_MIN_CONTEXT = 64_000;

/** OpenClaw and Hermes call tools on every turn. Hermes also needs a 64k window. */
function agentCanRun(model: CuratedModel, framework: AgentFramework): boolean {
  return model.metadata?.capabilities?.tools === true && (framework !== 'hermes' || model.runtime.contextWindow >= HERMES_MIN_CONTEXT);
}

/**
 * The agents among `frameworks` that cannot run on `model`. Mirrors the table the Hub's handout filters
 * on, so the wizard says what the handout will do: hand such an agent another model, or download one for it.
 */
export function agentsUnsuitedTo(model: CuratedModel | undefined, frameworks: readonly AgentFramework[]): AgentFramework[] {
  if (model?.modality !== 'llm') return [];
  return frameworks.filter((framework) => !agentCanRun(model, framework));
}

/** The model an agent gets when the Default cannot run it, and where that model comes from. */
export type AgentModelPlan = { kind: 'installed' | 'ticked' | 'download'; model: CuratedModel } | { kind: 'none' };

/**
 * What the Hub gives `framework` when the Default cannot run it (`AppCredentialsService`): the model the
 * engine has that the wizard ranks highest among those the agent can run, else one ticked here (it
 * downloads with the rest), else the smallest recommended one it can run, which the Hub downloads.
 */
export function agentModelPlan(
  framework: AgentFramework,
  options: {
    backend: InferenceBackendType;
    availableModels: readonly CuratedModel[];
    recommendedModels: readonly CuratedModel[];
    installedIds: readonly string[];
    tickedIds: readonly string[];
  },
): AgentModelPlan {
  const { backend, availableModels, recommendedModels } = options;
  const accept = (model: CuratedModel) => agentCanRun(model, framework);
  const pick = (candidateIds: readonly string[]) => {
    const id = defaultChatModelId({ backend, availableModels, recommendedModels, candidateIds, candidatesOnly: true, accept });
    return id ? availableModels.find((model) => model.id === id) : undefined;
  };
  const installed = pick(options.installedIds);
  if (installed) return { kind: 'installed', model: installed };
  const ticked = pick(options.tickedIds);
  if (ticked) return { kind: 'ticked', model: ticked };
  const download = smallestDownload(recommendedModels.filter((model) => model.backend === backend && model.modality === 'llm' && accept(model)));
  return download ? { kind: 'download', model: download } : { kind: 'none' };
}
