import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { openExternal } from '@/lib/helpers/open-external';
import type { MlxStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MlxIcon } from './icons';

const MLX_DOCS_URL = 'https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md';

interface MlxSetupCardProps {
  status: MlxStatus | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
  endpointUrl?: string;
  onEndpointUrlChange?: (value: string) => void;
}

const MlxProbeError = ({ error }: { error: string }) => {
  const { t } = useTranslation();
  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3"
      data-testid="mlx-probe-error"
      role="alert"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-destructive">{t('ONBOARDING_MLX_PROBE_ERROR_TITLE')}</p>
        <p className="mt-1 break-all font-mono text-xs text-destructive/90">{error}</p>
      </div>
    </div>
  );
};

const MlxConnectionFields = ({
  endpointUrl,
  onEndpointUrlChange,
  labelClass,
  hintClass,
  defaultEndpointUrl,
  idSuffix,
}: Pick<MlxSetupCardProps, 'endpointUrl' | 'onEndpointUrlChange'> & {
  labelClass: string;
  hintClass: string;
  defaultEndpointUrl?: string;
  idSuffix: string;
}) => {
  const { t } = useTranslation();
  if (!onEndpointUrlChange) return null;
  return (
    <div className="min-w-0">
      <label htmlFor={`mlx-endpoint-url-${idSuffix}`} className={`mb-1 block text-xs font-medium ${labelClass}`}>
        {t('ONBOARDING_MLX_ENDPOINT_URL_LABEL')}
      </label>
      <Input
        id={`mlx-endpoint-url-${idSuffix}`}
        type="text"
        autoComplete="off"
        value={endpointUrl ?? ''}
        onChange={(event) => onEndpointUrlChange(event.target.value)}
        placeholder={defaultEndpointUrl || t('ONBOARDING_MLX_ENDPOINT_URL_PLACEHOLDER')}
        data-testid="mlx-endpoint-url-input"
        className="w-full max-w-full"
      />
      <p className={`mt-1 text-xs ${hintClass}`}>{t('ONBOARDING_MLX_ENDPOINT_URL_HINT')}</p>
    </div>
  );
};

export const MlxSetupCard = ({ status, checking, onRecheck, endpointUrl, onEndpointUrlChange }: MlxSetupCardProps) => {
  const { t } = useTranslation();

  if (!status) {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">{t('ONBOARDING_MLX_CHECKING')}</div>
              <div className="text-xs text-muted-foreground">{t('ONBOARDING_MLX_LOOKING_HOST')}</div>
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
      <Card className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600 dark:text-green-400" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-green-900 dark:text-green-100">{t('ONBOARDING_MLX_DETECTED')}</div>
                <div className="text-xs text-green-700 dark:text-green-300">{endpoint}</div>
                <div className="mt-0.5 truncate text-xs text-green-700/90 dark:text-green-300/90">
                  {loadedModel ? t('ONBOARDING_MLX_MODEL_LOADED', { model: loadedModel }) : t('ONBOARDING_MLX_NO_MODEL_LOADED')}
                </div>
              </div>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={onRecheck}
              loading={checking}
              aria-label={t('ONBOARDING_MLX_RECHECK')}
              data-testid="mlx-recheck-btn"
              className="shrink-0"
            >
              {!checking && <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <MlxConnectionFields
            endpointUrl={endpointUrl}
            onEndpointUrlChange={onEndpointUrlChange}
            labelClass="text-green-900 dark:text-green-100"
            hintClass="text-green-700/90 dark:text-green-300/90"
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
              <MlxIcon className="h-4 w-4 shrink-0" />
              {t('ONBOARDING_MLX_NOT_DETECTED')}
            </div>
            <div className="mb-3 text-xs text-yellow-700 dark:text-yellow-300">{status.hint ?? t('ONBOARDING_MLX_NOT_DETECTED_DESC')}</div>
            {status.error && <MlxProbeError error={status.error} />}
            {status.remediationCommand && (
              <div className="mb-3 min-w-0" data-testid="mlx-remediation-command">
                <div className="mb-1 text-xs font-medium text-yellow-900 dark:text-yellow-100">{t('ONBOARDING_OLLAMA_RUN_ON_HOST')}</div>
                <code className="block w-full max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded bg-yellow-100 px-2 py-1.5 text-xs text-yellow-900 dark:bg-yellow-900 dark:text-yellow-100">
                  {status.remediationCommand}
                </code>
              </div>
            )}
            <div className="mb-3">
              <MlxConnectionFields
                endpointUrl={endpointUrl}
                onEndpointUrlChange={onEndpointUrlChange}
                labelClass="text-yellow-900 dark:text-yellow-100"
                hintClass="text-yellow-700/90 dark:text-yellow-300/90"
                defaultEndpointUrl={status.endpointUrl}
                idSuffix="unready"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => openExternal(MLX_DOCS_URL)}>
                {t('ONBOARDING_MLX_DOCS')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} data-testid="mlx-recheck-btn">
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('ONBOARDING_MLX_RECHECK')}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
