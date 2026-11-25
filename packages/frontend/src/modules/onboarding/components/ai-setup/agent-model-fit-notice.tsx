import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentFramework } from '../../helpers/ai-setup-types';
import { agentsUnsuitedTo } from '../../helpers/agent-model-fit';
import { isHostServedBackend } from '../../helpers/inference-backend-availability';

const NEEDS_KEY: Record<AgentFramework, string> = {
  openclaw: 'ONBOARDING_MODELS_OPENCLAW_NEEDS',
  hermes: 'ONBOARDING_MODELS_HERMES_NEEDS',
};

// vLLM and oMLX: an app's handout never starts a download there, so the Hub can only hand the agent
// another model the engine already serves.
const NEEDS_SERVED_KEY: Record<AgentFramework, string> = {
  openclaw: 'ONBOARDING_MODELS_OPENCLAW_NEEDS_SERVED',
  hermes: 'ONBOARDING_MODELS_HERMES_NEEDS_SERVED',
};

const APP_NAME_KEY: Record<AgentFramework, string> = {
  openclaw: 'ONBOARDING_AGENT_FRAMEWORK_OPENCLAW',
  hermes: 'ONBOARDING_AGENT_FRAMEWORK_HERMES',
};

/**
 * Says so when the Default (the model the agents are handed) cannot run an agent picked above. The
 * Hub then hands that agent another model or downloads one for it (#2538). Nothing on the page said so.
 */
export function AgentModelFitNotice({
  model,
  frameworks,
  backend,
}: {
  model: CuratedModel | undefined;
  frameworks: readonly AgentFramework[];
  backend?: InferenceBackendType;
}) {
  const { t } = useTranslation();
  const unsuited = agentsUnsuitedTo(model, frameworks);
  if (!model || unsuited.length === 0) return null;
  const keys = isHostServedBackend(backend) ? NEEDS_SERVED_KEY : NEEDS_KEY;
  return (
    <div
      className="mb-4 space-y-1 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
      data-testid="agent-model-unsuited"
    >
      {unsuited.map((framework) => (
        <p key={framework} className="flex items-start gap-1.5" data-testid={`agent-model-unsuited-${framework}`}>
          <TriangleAlert className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
          <span>{t(keys[framework], { app: t(APP_NAME_KEY[framework]), model: model.displayName })}</span>
        </p>
      ))}
    </div>
  );
}
