import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { InstallSummary, AiSetupConfig } from '../helpers/types';
import { IconBadge, WizardCard } from './wizard-ui';
import { useTranslation } from 'react-i18next';

interface CompleteStepProps {
  /** undefined when no install step was executed (user skipped). */
  installSummary?: InstallSummary;
  /** AI setup configuration from the AI step. */
  aiSetupConfig?: AiSetupConfig;
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function completionCopy(t: TranslateFn, summary?: InstallSummary) {
  if (!summary || summary.total === 0) {
    return {
      emoji: '🚀',
      heading: t('ONBOARDING_COMPLETE_HUB_READY'),
      body: t('ONBOARDING_COMPLETE_INSTALL_ANYTIME'),
      cta: t('ONBOARDING_GO_TO_APP_STORE'),
    };
  }

  const { running, incomplete, failed, total } = summary;

  if (running === total) {
    return {
      emoji: '🎉',
      heading: t('ONBOARDING_COMPLETE_ALL_APPS_RUNNING'),
      body: t('ONBOARDING_COMPLETE_ALL_APPS_RUNNING_BODY', { count: total }),
      cta: t('ONBOARDING_GO_TO_APP_STORE'),
    };
  }

  if (failed === total) {
    return {
      emoji: '⚠️',
      heading: t('ONBOARDING_COMPLETE_INSTALLATION_ISSUES'),
      body: t('ONBOARDING_COMPLETE_ALL_INSTALLS_FAILED', { count: total }),
      cta: t('ONBOARDING_GO_TO_APP_STORE'),
    };
  }

  const parts: string[] = [];
  if (running > 0) parts.push(t('ONBOARDING_COMPLETE_RUNNING_COUNT', { count: running }));
  if (incomplete > 0) parts.push(t('ONBOARDING_COMPLETE_STARTING_COUNT', { count: incomplete }));
  if (failed > 0) parts.push(t('ONBOARDING_COMPLETE_FAILED_COUNT', { count: failed }));

  return {
    emoji: incomplete > 0 || failed > 0 ? '🔧' : '✅',
    heading: t('ONBOARDING_COMPLETE_HUB_READY'),
    body: parts.join(', ') || t('ONBOARDING_COMPLETE_APPS_STARTING_UP'),
    cta: t('ONBOARDING_GO_TO_APP_STORE'),
  };
}

export const CompleteStep = ({ installSummary, aiSetupConfig }: CompleteStepProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { refreshAppContext } = useAppContext();
  const [loading, setLoading] = useState(false);
  const copy = completionCopy(t, installSummary);

  const handleFinish = async () => {
    setLoading(true);
    try {
      await apiFetch('/api/complete-onboarding', {
        method: 'PATCH',
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
            <p>{t('ONBOARDING_COMPLETE_AI_NOT_CONFIGURED')}</p>
          </div>
        )}

        <Button intent="primary" onClick={handleFinish} loading={loading} disabled={loading} className="mt-6 w-64" data-testid="complete-cta">
          {copy.cta}
        </Button>
      </div>
    </WizardCard>
  );
};
