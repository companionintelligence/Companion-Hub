import type { CuratedModel } from '@ci-hub/common/types';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentFramework } from '../../helpers/ai-setup-types';
import { agentsUnsuitedTo } from '../../helpers/agent-model-fit';

const NEEDS_KEY: Record<AgentFramework, string> = {
  openclaw: 'ONBOARDING_MODELS_OPENCLAW_NEEDS',
  hermes: 'ONBOARDING_MODELS_HERMES_NEEDS',
};

const APP_NAME_KEY: Record<AgentFramework, string> = {
  openclaw: 'ONBOARDING_AGENT_FRAMEWORK_OPENCLAW',
  hermes: 'ONBOARDING_AGENT_FRAMEWORK_HERMES',
};

/**
 * Says so when the Default (the model the agents are handed) cannot run an agent picked above. The
 * Hub then hands that agent another model, or downloads one for it (#2538), and nothing on the page
 * said so.
 */
export function AgentModelFitNotice({ model, frameworks }: { model: CuratedModel | undefined; frameworks: readonly AgentFramework[] }) {
  const { t } = useTranslation();
  const unsuited = agentsUnsuitedTo(model, frameworks);
  if (!model || unsuited.length === 0) return null;
  return (
    <div
      className="mb-4 space-y-1 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
      data-testid="agent-model-unsuited"
    >
      {unsuited.map((framework) => (
        <p key={framework} className="flex items-start gap-1.5" data-testid={`agent-model-unsuited-${framework}`}>
          <TriangleAlert className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
          <span>{t(NEEDS_KEY[framework], { app: t(APP_NAME_KEY[framework]), model: model.displayName })}</span>
        </p>
      ))}
    </div>
  );
}
