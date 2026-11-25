import { type CuratedModel, type InferenceBackendType, modelDownloadMb } from '@ci-hub/common/types';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentFramework } from '../../helpers/ai-setup-types';
import { agentModelPlan, agentsUnsuitedTo } from '../../helpers/agent-model-fit';
import { formatSize } from './model-selection-card';

const NEEDS_KEY: Record<AgentFramework, string> = {
  openclaw: 'ONBOARDING_MODELS_OPENCLAW_NEEDS',
  hermes: 'ONBOARDING_MODELS_HERMES_NEEDS',
};

const CHOOSE_KEY: Record<AgentFramework, string> = {
  openclaw: 'ONBOARDING_MODELS_OPENCLAW_CHOOSE',
  hermes: 'ONBOARDING_MODELS_HERMES_CHOOSE',
};

const APP_NAME_KEY: Record<AgentFramework, string> = {
  openclaw: 'ONBOARDING_AGENT_FRAMEWORK_OPENCLAW',
  hermes: 'ONBOARDING_AGENT_FRAMEWORK_HERMES',
};

/**
 * Says so when the Default that Continue saves (`model`) cannot run an agent picked above, or there is
 * none, and names the model the agent gets instead: one already here, one ticked, or the one the Hub will
 * download, with its size (#2538).
 */
export function AgentModelFitNotice({
  model,
  frameworks,
  backend,
  availableModels,
  recommendedModels,
  installedIds,
  tickedIds,
}: {
  model: CuratedModel | undefined;
  frameworks: readonly AgentFramework[];
  backend: InferenceBackendType;
  availableModels: readonly CuratedModel[];
  recommendedModels: readonly CuratedModel[];
  installedIds: readonly string[];
  tickedIds: readonly string[];
}) {
  const { t } = useTranslation();
  const unsuited = model ? agentsUnsuitedTo(model, frameworks) : frameworks;
  if (unsuited.length === 0) return null;
  // Only Ollama and Lemonade download for an app's handout. vLLM serves the one model it started with,
  // and on oMLX only the models ticked here download.
  const hubDownloads = backend === 'ollama' || backend === 'lemonade';
  return (
    <div
      className="mb-4 space-y-1 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
      data-testid="agent-model-unsuited"
    >
      {unsuited.map((framework) => {
        const app = t(APP_NAME_KEY[framework]);
        const plan = agentModelPlan(framework, { backend, availableModels, recommendedModels, installedIds, tickedIds });
        const outcome =
          plan.kind === 'installed'
            ? t('ONBOARDING_MODELS_AGENT_USES_INSTALLED', { app, model: plan.model.displayName })
            : plan.kind === 'ticked'
              ? t('ONBOARDING_MODELS_AGENT_USES_TICKED', { app, model: plan.model.displayName })
              : hubDownloads
                ? plan.kind === 'download'
                  ? t('ONBOARDING_MODELS_AGENT_DOWNLOADS', { app, model: plan.model.displayName, size: formatSize(modelDownloadMb(plan.model)) })
                  : t('ONBOARDING_MODELS_AGENT_NO_MODEL', { app })
                : t('ONBOARDING_MODELS_AGENT_SERVED_ONLY', { app });
        const sentences = [
          t(NEEDS_KEY[framework], { app }),
          model ? t('ONBOARDING_MODELS_DEFAULT_CANNOT', { model: model.displayName }) : t('ONBOARDING_MODELS_NO_CHAT_MODEL'),
          outcome,
          ...(plan.kind === 'installed' || plan.kind === 'ticked' ? [] : [t(CHOOSE_KEY[framework])]),
        ];
        return (
          <p key={framework} className="flex items-start gap-1.5" data-testid={`agent-model-unsuited-${framework}`}>
            <TriangleAlert className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
            <span>{sentences.join(' ')}</span>
          </p>
        );
      })}
    </div>
  );
}
