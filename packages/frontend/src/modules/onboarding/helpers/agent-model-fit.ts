import type { CuratedModel } from '@ci-hub/common/types';
import type { AgentFramework } from './ai-setup-types';

/** The context window Hermes refuses to start below (the backend's `app-inference-requirements.ts`). */
export const HERMES_MIN_CONTEXT = 64_000;

/**
 * The agents among `frameworks` that cannot run on `model`: OpenClaw and Hermes call tools on every
 * turn. Hermes also needs a 64k window. Mirrors the table the Hub's handout filters on, so the
 * wizard says what the handout will do: hand such an agent another model, or download one for it.
 */
export function agentsUnsuitedTo(model: CuratedModel | undefined, frameworks: readonly AgentFramework[]): AgentFramework[] {
  if (model?.modality !== 'llm') return [];
  const tools = model.metadata?.capabilities?.tools === true;
  return frameworks.filter((framework) => !tools || (framework === 'hermes' && !(model.runtime.contextWindow >= HERMES_MIN_CONTEXT)));
}
