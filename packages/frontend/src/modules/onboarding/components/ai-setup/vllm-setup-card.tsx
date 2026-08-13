import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { openExternal } from '@/lib/helpers/open-external';
import type { VllmStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { CheckCircle2, Download, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const VLLM_DOCS_URL = 'https://docs.vllm.ai/en/latest/getting_started/quickstart.html';

function isVllmAuthError(error?: string): boolean {
  return !!error && (error.includes('401') || /api key/i.test(error));
}

/** Probe failures need to stand out inside the yellow "not detected" card. */
const VllmProbeError = ({ error }: { error: string }) => {
  const { t } = useTranslation();
  const authFailure = isVllmAuthError(error);

  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3"
      data-testid="vllm-probe-error"
      role="alert"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-destructive">
          {authFailure ? t('ONBOARDING_VLLM_PROBE_ERROR_AUTH_TITLE') : t('ONBOARDING_VLLM_PROBE_ERROR_TITLE')}
        </p>
        <p className="mt-1 break-all font-mono text-xs text-destructive/90">{error}</p>
        {authFailure && <p className="mt-2 text-xs leading-relaxed text-destructive/90">{t('ONBOARDING_VLLM_PROBE_ERROR_AUTH_HINT')}</p>}
      </div>
    </div>
  );
};

interface VllmSetupCardProps {
  status: VllmStatus | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  /** Operator-configured vLLM base URL; empty string means "use the Hub default". */
  endpointUrl?: string;
  onEndpointUrlChange?: (value: string) => void;
}

/** Endpoint URL + API key fields shared by the ready and not-ready branches. */
const VllmConnectionFields = ({
  apiKey,
  onApiKeyChange,
  endpointUrl,
  onEndpointUrlChange,
  labelClass,
  hintClass,
  defaultEndpointUrl,
  idSuffix,
}: Pick<VllmSetupCardProps, 'apiKey' | 'onApiKeyChange' | 'endpointUrl' | 'onEndpointUrlChange'> & {
  labelClass: string;
  hintClass: string;
  defaultEndpointUrl?: string;
  idSuffix: string;
}) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 min-w-0">
      {onEndpointUrlChange && (
        <div className="min-w-0">
          <label htmlFor={`vllm-endpoint-url-${idSuffix}`} className={`mb-1 block text-xs font-medium ${labelClass}`}>
            {t('ONBOARDING_VLLM_ENDPOINT_URL_LABEL')}
          </label>
          <Input
            id={`vllm-endpoint-url-${idSuffix}`}
            type="text"
            autoComplete="off"
            value={endpointUrl ?? ''}
            onChange={(e) => onEndpointUrlChange(e.target.value)}
            placeholder={defaultEndpointUrl || t('ONBOARDING_VLLM_ENDPOINT_URL_PLACEHOLDER')}
            data-testid="vllm-endpoint-url-input"
            className="w-full max-w-full"
          />
          <p className={`mt-1 text-xs ${hintClass}`}>{t('ONBOARDING_VLLM_ENDPOINT_URL_HINT')}</p>
        </div>
      )}
      <div className="min-w-0">
        <label htmlFor={`vllm-api-key-${idSuffix}`} className={`mb-1 block text-xs font-medium ${labelClass}`}>
          {t('ONBOARDING_VLLM_API_KEY_LABEL')}
        </label>
        <Input
          id={`vllm-api-key-${idSuffix}`}
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          placeholder={t('ONBOARDING_VLLM_API_KEY_PLACEHOLDER')}
          data-testid="vllm-api-key-input"
          className="w-full max-w-full"
        />
        <p className={`mt-1 text-xs ${hintClass}`}>{t('ONBOARDING_VLLM_API_KEY_HINT')}</p>
      </div>
    </div>
  );
};

export const VllmSetupCard = ({ status, checking, onRecheck, apiKey, onApiKeyChange, endpointUrl, onEndpointUrlChange }: VllmSetupCardProps) => {
  const { t } = useTranslation();

  if (!status) {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">{t('ONBOARDING_VLLM_CHECKING')}</div>
              <div className="text-xs text-muted-foreground">{t('ONBOARDING_VLLM_LOOKING_HOST')}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status.ready) {
    const endpoint = status.displayEndpoint ?? `${status.endpointUrl}/v1`;

    return (
      <Card className="border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950">
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600 dark:text-green-400" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-green-900 dark:text-green-100">{t('ONBOARDING_VLLM_DETECTED')}</div>
                <div className="text-xs text-green-700 dark:text-green-300">{endpoint}</div>
              </div>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={onRecheck}
              loading={checking}
              aria-label={t('ONBOARDING_VLLM_RECHECK')}
              data-testid="vllm-recheck-btn"
              className="shrink-0"
            >
              {!checking && <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <VllmConnectionFields
            apiKey={apiKey}
            onApiKeyChange={onApiKeyChange}
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
    <Card className="border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950 overflow-hidden">
      <CardContent className="p-4 min-w-0">
        <div className="flex items-start gap-3 min-w-0">
          <Download className="h-5 w-5 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-yellow-900 dark:text-yellow-100 mb-1">{t('ONBOARDING_VLLM_NOT_DETECTED')}</div>
            <div className="text-xs text-yellow-700 dark:text-yellow-300 mb-3">{status.hint ?? t('ONBOARDING_VLLM_NOT_DETECTED_DESC')}</div>
            {status.error && <VllmProbeError error={status.error} />}
            {status.remediationCommand && (
              <div className="mb-3 min-w-0" data-testid="vllm-remediation-command">
                <div className="mb-1 text-xs font-medium text-yellow-900 dark:text-yellow-100">{t('ONBOARDING_OLLAMA_RUN_ON_HOST')}</div>
                <code className="block w-full max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded bg-yellow-100 dark:bg-yellow-900 px-2 py-1.5 text-xs text-yellow-900 dark:text-yellow-100">
                  {status.remediationCommand}
                </code>
              </div>
            )}
            <div className="mb-3">
              <VllmConnectionFields
                apiKey={apiKey}
                onApiKeyChange={onApiKeyChange}
                endpointUrl={endpointUrl}
                onEndpointUrlChange={onEndpointUrlChange}
                labelClass="text-yellow-900 dark:text-yellow-100"
                hintClass="text-yellow-700/90 dark:text-yellow-300/90"
                defaultEndpointUrl={status.endpointUrl}
                idSuffix="unready"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" variant="ghost" onClick={() => openExternal(VLLM_DOCS_URL)}>
                {t('ONBOARDING_VLLM_DOCS')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} data-testid="vllm-recheck-btn">
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                {t('ONBOARDING_VLLM_RECHECK')}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
