import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { openExternal } from '@/lib/helpers/open-external';
import type { SpeculativeInferenceStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const SPECULATIVE_INFERENCE_GUIDE_URL = 'https://docs.ci.computer/docs/features/inference-and-ai#speculative-inference';

interface SpeculativeInferenceSetupCardProps {
  status: SpeculativeInferenceStatus | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
}

/** The speculative inference server is configured outside the Hub; this card only probes it. */
export const SpeculativeInferenceSetupCard = ({ status, checking, onRecheck }: SpeculativeInferenceSetupCardProps) => {
  const { t } = useTranslation();

  if (!status) {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">{t('ONBOARDING_SPECULATIVE_CHECKING')}</div>
              <div className="text-xs text-muted-foreground">{t('ONBOARDING_SPECULATIVE_LOOKING_HOST')}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status.ready) {
    const endpoint = status.displayEndpoint ?? `${status.endpointUrl}/v1`;
    return (
      <Card className="border-success/30 bg-success/10">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-success">{t('ONBOARDING_SPECULATIVE_DETECTED')}</div>
                <div className="text-xs text-success">{endpoint}</div>
              </div>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={onRecheck}
              loading={checking}
              aria-label={t('ONBOARDING_SPECULATIVE_RECHECK')}
              data-testid="speculative-inference-recheck-btn"
              className="shrink-0"
            >
              {!checking && <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-warning/30 bg-warning/10">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Download className="h-5 w-5 shrink-0 mt-0.5 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-sm font-medium text-warning">{t('ONBOARDING_SPECULATIVE_NOT_DETECTED')}</div>
            <div className="mb-3 text-xs text-warning">{status.hint ?? t('ONBOARDING_SPECULATIVE_NOT_DETECTED_DESC')}</div>
            {status.error && <div className="mb-3 break-all font-mono text-xs text-warning">{status.error}</div>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => openExternal(SPECULATIVE_INFERENCE_GUIDE_URL)}>
                {t('ONBOARDING_SPECULATIVE_DOCS')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} data-testid="speculative-inference-recheck-btn">
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                {t('ONBOARDING_SPECULATIVE_RECHECK')}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
