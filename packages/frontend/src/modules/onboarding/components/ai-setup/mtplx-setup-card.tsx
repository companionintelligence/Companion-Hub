import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { openExternal } from '@/lib/helpers/open-external';
import type { MtplxStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const MTPLX_DOCS_URL = 'https://github.com/youssofal/MTPLX';

const MtplxProbeError = ({ error }: { error: string }) => {
  const { t } = useTranslation();

  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3"
      data-testid="mtplx-probe-error"
      role="alert"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-destructive">{t('ONBOARDING_MTPLX_PROBE_ERROR_TITLE')}</p>
        <p className="mt-1 break-all font-mono text-xs text-destructive/90">{error}</p>
      </div>
    </div>
  );
};

interface MtplxSetupCardProps {
  status: MtplxStatus | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
  /** Operator-configured MTPLX base URL; empty string means "use the Hub default". */
  endpointUrl?: string;
  onEndpointUrlChange?: (value: string) => void;
}

/** Endpoint URL field shared by the ready and not-ready branches. MTPLX has no API key concept —
 *  its server is local-only with no auth, unlike vLLM's optional --api-key. */
const MtplxConnectionFields = ({
  endpointUrl,
  onEndpointUrlChange,
  labelClass,
  hintClass,
  defaultEndpointUrl,
  idSuffix,
}: Pick<MtplxSetupCardProps, 'endpointUrl' | 'onEndpointUrlChange'> & {
  labelClass: string;
  hintClass: string;
  defaultEndpointUrl?: string;
  idSuffix: string;
}) => {
  const { t } = useTranslation();
  if (!onEndpointUrlChange) return null;
  return (
    <div className="min-w-0">
      <label htmlFor={`mtplx-endpoint-url-${idSuffix}`} className={`mb-1 block text-xs font-medium ${labelClass}`}>
        {t('ONBOARDING_MTPLX_ENDPOINT_URL_LABEL')}
      </label>
      <Input
        id={`mtplx-endpoint-url-${idSuffix}`}
        type="text"
        autoComplete="off"
        value={endpointUrl ?? ''}
        onChange={(e) => onEndpointUrlChange(e.target.value)}
        placeholder={defaultEndpointUrl || t('ONBOARDING_MTPLX_ENDPOINT_URL_PLACEHOLDER')}
        data-testid="mtplx-endpoint-url-input"
        className="w-full max-w-full"
      />
      <p className={`mt-1 text-xs ${hintClass}`}>{t('ONBOARDING_MTPLX_ENDPOINT_URL_HINT')}</p>
    </div>
  );
};

export const MtplxSetupCard = ({ status, checking, onRecheck, endpointUrl, onEndpointUrlChange }: MtplxSetupCardProps) => {
  const { t } = useTranslation();

  if (!status) {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">{t('ONBOARDING_MTPLX_CHECKING')}</div>
              <div className="text-xs text-muted-foreground">{t('ONBOARDING_MTPLX_LOOKING_HOST')}</div>
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
                <div className="text-sm font-medium text-green-900 dark:text-green-100">{t('ONBOARDING_MTPLX_DETECTED')}</div>
                <div className="text-xs text-green-700 dark:text-green-300">{endpoint}</div>
              </div>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={onRecheck}
              loading={checking}
              aria-label={t('ONBOARDING_MTPLX_RECHECK')}
              data-testid="mtplx-recheck-btn"
              className="shrink-0"
            >
              {!checking && <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <MtplxConnectionFields
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
            <div className="mb-1 text-sm font-medium text-yellow-900 dark:text-yellow-100">{t('ONBOARDING_MTPLX_NOT_DETECTED')}</div>
            <div className="mb-3 text-xs text-yellow-700 dark:text-yellow-300">{status.hint ?? t('ONBOARDING_MTPLX_NOT_DETECTED_DESC')}</div>
            {status.error && <MtplxProbeError error={status.error} />}
            {status.remediationCommand && (
              <div className="mb-3 min-w-0" data-testid="mtplx-remediation-command">
                <div className="mb-1 text-xs font-medium text-yellow-900 dark:text-yellow-100">{t('ONBOARDING_OLLAMA_RUN_ON_HOST')}</div>
                <code className="block w-full max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded bg-yellow-100 px-2 py-1.5 text-xs text-yellow-900 dark:bg-yellow-900 dark:text-yellow-100">
                  {status.remediationCommand}
                </code>
              </div>
            )}
            <div className="mb-3">
              <MtplxConnectionFields
                endpointUrl={endpointUrl}
                onEndpointUrlChange={onEndpointUrlChange}
                labelClass="text-yellow-900 dark:text-yellow-100"
                hintClass="text-yellow-700/90 dark:text-yellow-300/90"
                defaultEndpointUrl={status.endpointUrl}
                idSuffix="unready"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" variant="ghost" onClick={() => openExternal(MTPLX_DOCS_URL)}>
                {t('ONBOARDING_MTPLX_DOCS')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} data-testid="mtplx-recheck-btn">
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                {t('ONBOARDING_MTPLX_RECHECK')}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
