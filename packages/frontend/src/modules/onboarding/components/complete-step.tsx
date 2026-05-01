import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { useAppContext } from '@/context/app-context';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { InstallSummary, AiSetupConfig } from '../helpers/types';

interface CompleteStepProps {
  /** undefined when no install step was executed (user skipped). */
  installSummary?: InstallSummary;
  /** AI setup configuration from the AI step. */
  aiSetupConfig?: AiSetupConfig;
}

function completionCopy(summary?: InstallSummary) {
  if (!summary || summary.total === 0) {
    return {
      emoji: '🚀',
      heading: 'Your Hub Is Ready',
      body: 'You can install apps anytime from the App Store.',
      cta: 'Go to App Store',
    };
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
    <Card>
      <CardContent className="p-8 text-center">
        <div className="text-5xl mb-4">{copy.emoji}</div>
        <h2 className="text-xl font-semibold mb-2" data-testid="complete-heading">
          {copy.heading}
        </h2>
        <p className="text-muted-foreground max-w-md mx-auto mb-6" data-testid="complete-body">
          {copy.body}
        </p>

        {/* AI Setup Summary */}
        {aiSetupConfig && (
          <div className="text-sm text-muted-foreground mb-6 max-w-md mx-auto" data-testid="ai-summary">
            {aiSetupConfig.skipped ? (
              <p>AI not configured. You can set it up anytime in Settings → AI.</p>
            ) : (
              <div className="space-y-1">
                {aiSetupConfig.selectedModels.length > 0 && (
                  <p>
                    🧠 {aiSetupConfig.selectedModels.length} AI model{aiSetupConfig.selectedModels.length === 1 ? '' : 's'} configured
                  </p>
                )}
                {aiSetupConfig.cloudProviders.length > 0 && (
                  <p>
                    ☁️ {aiSetupConfig.cloudProviders.length} cloud provider{aiSetupConfig.cloudProviders.length === 1 ? '' : 's'} configured
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <Button intent="primary" onClick={handleFinish} loading={loading} disabled={loading} className="w-64" data-testid="complete-cta">
          {copy.cta}
        </Button>
      </CardContent>
    </Card>
  );
};
