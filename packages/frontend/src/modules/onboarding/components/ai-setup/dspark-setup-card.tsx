import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { openExternal } from '@/lib/helpers/open-external';
import type { DsparkStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DsparkIcon } from './icons';
import { AutoInstallRunnerButton } from './auto-install-runner-button';

const DSPARK_DOCS_URL = 'https://github.com/ARahim3/mlx-dspark#install';

const DsparkProbeError = ({ error }: { error: string }) => {
  const { t } = useTranslation();

  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3"
      data-testid="dspark-probe-error"
      role="alert"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-destructive">{t('ONBOARDING_DSPARK_PROBE_ERROR_TITLE')}</p>
        <p className="mt-1 break-all font-mono text-xs text-destructive/90">{error}</p>
      </div>
    </div>
  );
};

interface DsparkSetupCardProps {
  status: DsparkStatus | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
  /** Operator-configured mlx-dspark base URL; empty string means "use the Hub default". */
  endpointUrl?: string;
  onEndpointUrlChange?: (value: string) => void;
  onAutoInstall?: () => Promise<void>;
}

/**
 * Endpoint URL field. Unlike {@link VllmSetupCard} there is no API-key input: mlx-dspark defaults to
 * no key, and `GET /health` — the route the Hub probes — stays auth-exempt even when one is set, so
 * detection works either way.
 */
const DsparkConnectionFields = ({
  endpointUrl,
  onEndpointUrlChange,
  labelClass,
  hintClass,
  defaultEndpointUrl,
  idSuffix,
}: Pick<DsparkSetupCardProps, 'endpointUrl' | 'onEndpointUrlChange'> & {
  labelClass: string;
  hintClass: string;
  defaultEndpointUrl?: string;
  idSuffix: string;
}) => {
  const { t } = useTranslation();
  if (!onEndpointUrlChange) return null;
  return (
    <div className="min-w-0">
      <label htmlFor={`dspark-endpoint-url-${idSuffix}`} className={`mb-1 block text-xs font-medium ${labelClass}`}>
        {t('ONBOARDING_DSPARK_ENDPOINT_URL_LABEL')}
      </label>
      <Input
        id={`dspark-endpoint-url-${idSuffix}`}
        type="text"
        autoComplete="off"
        value={endpointUrl ?? ''}
        onChange={(e) => onEndpointUrlChange(e.target.value)}
        placeholder={defaultEndpointUrl || t('ONBOARDING_DSPARK_ENDPOINT_URL_PLACEHOLDER')}
        data-testid="dspark-endpoint-url-input"
        className="w-full max-w-full"
      />
      <p className={`mt-1 text-xs ${hintClass}`}>{t('ONBOARDING_DSPARK_ENDPOINT_URL_HINT')}</p>
    </div>
  );
};

export const DsparkSetupCard = ({ status, checking, onRecheck, endpointUrl, onEndpointUrlChange, onAutoInstall }: DsparkSetupCardProps) => {
  const { t } = useTranslation();

  if (!status) {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">{t('ONBOARDING_DSPARK_CHECKING')}</div>
              <div className="text-xs text-muted-foreground">{t('ONBOARDING_DSPARK_LOOKING_HOST')}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status.ready) {
    const endpoint = status.displayEndpoint ?? `${status.endpointUrl}/v1`;
    // A reachable server started with `--no-model` is healthy but serving nothing yet. Say so
    // rather than showing a bare "detected" that implies a model is ready to answer.
    const loadedModel = status.loadedModels?.[0];

    return (
      <Card className="border-ci-success-border bg-ci-success-bg">
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-ci-success" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-ci-success">{t('ONBOARDING_DSPARK_DETECTED')}</div>
                <div className="text-xs text-ci-success/90">{endpoint}</div>
                <div className="mt-0.5 truncate text-xs text-ci-success/80">
                  {loadedModel ? t('ONBOARDING_DSPARK_MODEL_LOADED', { model: loadedModel }) : t('ONBOARDING_DSPARK_NO_MODEL_LOADED')}
                </div>
              </div>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={onRecheck}
              loading={checking}
              aria-label={t('ONBOARDING_DSPARK_RECHECK')}
              data-testid="dspark-recheck-btn"
              className="shrink-0"
            >
              {!checking && <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <DsparkConnectionFields
            endpointUrl={endpointUrl}
            onEndpointUrlChange={onEndpointUrlChange}
            labelClass="text-ci-success"
            hintClass="text-ci-success/80"
            defaultEndpointUrl={status.endpointUrl}
            idSuffix="ready"
          />
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
              <DsparkIcon className="h-4 w-4 shrink-0" />
              {t('ONBOARDING_DSPARK_NOT_DETECTED')}
            </div>
            <div className="mb-3 text-xs text-yellow-700 dark:text-yellow-300">{status.hint ?? t('ONBOARDING_DSPARK_NOT_DETECTED_DESC')}</div>
            {status.error && <DsparkProbeError error={status.error} />}
            {status.remediationCommand && (
              <div className="mb-3 min-w-0" data-testid="dspark-remediation-command">
                <div className="mb-1 text-xs font-medium text-yellow-900 dark:text-yellow-100">{t('ONBOARDING_OLLAMA_RUN_ON_HOST')}</div>
                <code className="block w-full max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded bg-yellow-100 px-2 py-1.5 text-xs text-yellow-900 dark:bg-yellow-900 dark:text-yellow-100">
                  {status.remediationCommand}
                </code>
              </div>
            )}
            <div className="mb-3">
              <DsparkConnectionFields
                endpointUrl={endpointUrl}
                onEndpointUrlChange={onEndpointUrlChange}
                labelClass="text-yellow-900 dark:text-yellow-100"
                hintClass="text-yellow-700/90 dark:text-yellow-300/90"
                defaultEndpointUrl={status.endpointUrl}
                idSuffix="unready"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {onAutoInstall && <AutoInstallRunnerButton onRun={onAutoInstall} />}
              <Button size="sm" variant="ghost" onClick={() => openExternal(DSPARK_DOCS_URL)}>
                {t('ONBOARDING_DSPARK_DOCS')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} data-testid="dspark-recheck-btn">
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                {t('ONBOARDING_DSPARK_RECHECK')}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
