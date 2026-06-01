import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { InstallSummary, AiSetupConfig } from '../helpers/types';
import { IconBadge, WizardCard } from './wizard-ui';

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
    emoji: incomplete > 0 || failed > 0 ? '🔧' : '✅',
    heading: 'Your Hub Is Ready',
    body: parts.join(', ') || 'Apps are starting up.',
    cta: 'Go to App Store',
  };
}

export const CompleteStep = ({ installSummary, aiSetupConfig }: CompleteStepProps) => {
  const navigate = useNavigate();
  const { refreshAppContext } = useAppContext();
  const [loading, setLoading] = useState(false);
  const copy = completionCopy(installSummary);

  const handleFinish = async () => {
    setLoading(true);
    try {
      await apiFetch('/api/complete-onboarding', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      await refreshAppContext();
      navigate('/store', { replace: true });
    } catch {
      navigate('/store', { replace: true });
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

        {aiSetupConfig?.skipped && (
          <div
            className="mt-5 w-full max-w-md rounded-2xl border border-border bg-foreground/[0.015] p-4 text-sm text-muted-foreground"
            data-testid="ai-summary"
          >
            <p>AI not configured. You can set it up anytime in Settings → AI.</p>
          </div>
        )}

        <Button intent="primary" onClick={handleFinish} loading={loading} disabled={loading} className="mt-6 w-64" data-testid="complete-cta">
          {copy.cta}
        </Button>
      </div>
    </WizardCard>
  );
};
