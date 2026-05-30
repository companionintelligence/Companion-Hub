import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AGENT_APP_SLUG } from '../helpers/ai-setup-types';
import type { InstallSummary, AiSetupConfig } from '../helpers/types';
import { IconBadge, WizardCard } from './wizard-ui';

const AGENT_SLUGS = Object.values(AGENT_APP_SLUG);

interface CompleteStepProps {
  /** undefined when no install step was executed (user skipped). */
  installSummary?: InstallSummary;
  /** AI setup configuration from the AI step. */
  aiSetupConfig?: AiSetupConfig;
}

function completionCopy(summary?: InstallSummary) {
  if (!summary || summary.total === 0) {
    return { emoji: '🚀', heading: 'Your Hub Is Ready', body: 'You can install apps anytime from the App Store.', cta: 'Go to App Store' };
  }

  const { running, incomplete, failed, total } = summary;

  if (running === total) {
    return {
      emoji: '🎉',
      heading: 'All Apps Running',
      body: `All ${total} app${total === 1 ? ' is' : 's are'} confirmed running on your Hub.`,
      cta: 'Go to App Store',
    };
  }

  if (failed === total) {
    return {
      emoji: '⚠️',
      heading: 'Installation Issues',
      body: `All ${total} install${total === 1 ? '' : 's'} failed. You can retry from the App Store.`,
      cta: 'Go to App Store',
    };
  }

  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (incomplete > 0) parts.push(`${incomplete} still starting`);
  if (failed > 0) parts.push(`${failed} failed`);

  return {
    emoji: incomplete > 0 || failed > 0 ? '🔧' : '🎉',
    heading: 'Setup Complete',
    body: `${parts.join(', ')}. You can manage your apps from the App Store.`,
    cta: 'Go to App Store',
  };
}

export const CompleteStep = ({ installSummary, aiSetupConfig }: CompleteStepProps) => {
  const navigate = useNavigate();
  const { refreshAppContext } = useAppContext();
  const [loading, setLoading] = useState(false);
  const copy = completionCopy(installSummary);

  // The agent app (openclaw / hermes-agent) that was actually queued for install, if any.
  const agentResult = installSummary?.results.find((r) => AGENT_SLUGS.includes(r.app.appSlug));
  const agentStatusText =
    agentResult?.status === 'running' ? 'is running' : agentResult?.status === 'failed' ? 'failed to install' : 'is starting up';

  // Only render the AI summary box when it has something to say — otherwise it's an empty box.
  const hasAiSummary = Boolean(
    agentResult || (aiSetupConfig && (aiSetupConfig.skipped || aiSetupConfig.selectedModels.length > 0 || aiSetupConfig.cloudProviders.length > 0)),
  );

  const handleFinish = async () => {
    setLoading(true);
    try {
      await apiFetch('/api/complete-onboarding', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      await refreshAppContext();
      navigate('/app-store', { replace: true });
    } catch {
      navigate('/app-store', { replace: true });
    }
  };

  return (
    <WizardCard className="text-center">
      <div className="flex flex-col items-center">
        <IconBadge className="text-3xl">
          <span aria-hidden="true">{copy.emoji}</span>
        </IconBadge>
        <h2 className="mt-5 text-2xl font-bold tracking-tight" data-testid="complete-heading">
          {copy.heading}
        </h2>
        <p className="mt-2 max-w-md text-muted-foreground" data-testid="complete-body">
          {copy.body}
        </p>

        {hasAiSummary && (
          <div
            className="mt-5 w-full max-w-md rounded-2xl border border-border bg-foreground/[0.015] p-4 text-sm text-muted-foreground"
            data-testid="ai-summary"
          >
            <div className="space-y-1">
              {agentResult && (
                <p data-testid="agent-summary">
                  🤖 {agentResult.app.name} agent {agentStatusText} — open it from the dashboard.
                </p>
              )}
              {aiSetupConfig?.skipped && !agentResult && <p>AI not configured. You can set it up anytime in Settings → AI.</p>}
              {!aiSetupConfig?.skipped && aiSetupConfig && aiSetupConfig.selectedModels.length > 0 && (
                <p>
                  🧠 {aiSetupConfig.selectedModels.length} AI model{aiSetupConfig.selectedModels.length === 1 ? '' : 's'} configured
                </p>
              )}
              {!aiSetupConfig?.skipped && aiSetupConfig && aiSetupConfig.cloudProviders.length > 0 && (
                <p>
                  ☁️ {aiSetupConfig.cloudProviders.length} cloud provider{aiSetupConfig.cloudProviders.length === 1 ? '' : 's'} configured
                </p>
              )}
            </div>
          </div>
        )}

        <Button intent="primary" onClick={handleFinish} loading={loading} disabled={loading} className="mt-6 w-64" data-testid="complete-cta">
          {copy.cta}
        </Button>
      </div>
    </WizardCard>
  );
};
