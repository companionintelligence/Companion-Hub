import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { openExternal } from '@/lib/helpers/open-external';
import type { LemonadeStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LemonadeIcon } from './icons';

const LEMONADE_DOCS_URL = 'https://github.com/lemonade-sdk/lemonade';

interface LemonadeSetupCardProps {
  status: LemonadeStatus | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
}

export const LemonadeSetupCard = ({ status, checking, onRecheck }: LemonadeSetupCardProps) => {
  const { t } = useTranslation();

  if (!status) {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">{t('ONBOARDING_LEMONADE_CHECKING')}</div>
              <div className="text-xs text-muted-foreground">{t('ONBOARDING_LEMONADE_LOOKING_HOST')}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status.ready) {
    const endpoint = status.displayEndpoint ?? `${status.endpointUrl}/v1`;
    const loadedModel = status.loadedModels?.[0];
    return (
      <Card className="border-ci-success-border bg-ci-success-bg">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-ci-success" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-ci-success">{t('ONBOARDING_LEMONADE_DETECTED')}</div>
                <div className="text-xs text-ci-success/90">{endpoint}</div>
                {loadedModel && (
                  <div className="mt-0.5 truncate text-xs text-ci-success/80">{t('ONBOARDING_LEMONADE_MODEL_LOADED', { model: loadedModel })}</div>
                )}
              </div>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={onRecheck}
              loading={checking}
              aria-label={t('ONBOARDING_LEMONADE_RECHECK')}
              data-testid="lemonade-recheck-btn"
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
    <Card className="overflow-hidden border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950">
      <CardContent className="min-w-0 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Download className="mt-0.5 h-5 w-5 shrink-0 text-yellow-600 dark:text-yellow-400" />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 text-sm font-medium text-yellow-900 dark:text-yellow-100">
              <LemonadeIcon className="h-4 w-4 shrink-0" />
              {t('ONBOARDING_LEMONADE_NOT_DETECTED')}
            </div>
            <div className="mb-3 text-xs text-yellow-700 dark:text-yellow-300">{status.hint ?? t('ONBOARDING_LEMONADE_NOT_DETECTED_DESC')}</div>
            {status.error && (
              <div
                className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3"
                data-testid="lemonade-probe-error"
                role="alert"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-destructive">{t('ONBOARDING_LEMONADE_PROBE_ERROR_TITLE')}</p>
                  <p className="mt-1 break-all font-mono text-xs text-destructive/90">{status.error}</p>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => openExternal(LEMONADE_DOCS_URL)}>
                {t('ONBOARDING_LEMONADE_DOCS')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} data-testid="lemonade-recheck-btn">
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('ONBOARDING_LEMONADE_RECHECK')}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
