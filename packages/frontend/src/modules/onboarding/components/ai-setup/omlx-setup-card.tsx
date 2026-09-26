import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { openExternal } from '@/lib/helpers/open-external';
import type { OmlxStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AutoInstallRunnerButton } from './auto-install-runner-button';

const OMLX_DOCS_URL = 'https://github.com/jundot/omlx';

const OmlxProbeError = ({ error }: { error: string }) => {
  const { t } = useTranslation();

  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3"
      data-testid="omlx-probe-error"
      role="alert"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-destructive">{t('ONBOARDING_OMLX_PROBE_ERROR_TITLE')}</p>
        <p className="mt-1 break-all font-mono text-xs text-destructive/90">{error}</p>
      </div>
    </div>
  );
};

interface OmlxSetupCardProps {
  status: OmlxStatus | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
  endpointUrl?: string;
  onEndpointUrlChange?: (value: string) => void;
  onAutoInstall?: () => Promise<void>;
}

const OmlxConnectionFields = ({
  endpointUrl,
  onEndpointUrlChange,
  labelClass,
  hintClass,
  defaultEndpointUrl,
  idSuffix,
}: Pick<OmlxSetupCardProps, 'endpointUrl' | 'onEndpointUrlChange'> & {
  labelClass: string;
  hintClass: string;
  defaultEndpointUrl?: string;
  idSuffix: string;
}) => {
  const { t } = useTranslation();
  if (!onEndpointUrlChange) return null;
  return (
    <div className="min-w-0">
      <label htmlFor={`omlx-endpoint-url-${idSuffix}`} className={`mb-1 block text-xs font-medium ${labelClass}`}>
        {t('ONBOARDING_OMLX_ENDPOINT_URL_LABEL')}
      </label>
      <Input
        id={`omlx-endpoint-url-${idSuffix}`}
        type="text"
        autoComplete="off"
        value={endpointUrl ?? ''}
        onChange={(e) => onEndpointUrlChange(e.target.value)}
        placeholder={defaultEndpointUrl || t('ONBOARDING_OMLX_ENDPOINT_URL_PLACEHOLDER')}
        data-testid="omlx-endpoint-url-input"
        className="w-full max-w-full"
      />
      <p className={`mt-1 text-xs ${hintClass}`}>{t('ONBOARDING_OMLX_ENDPOINT_URL_HINT')}</p>
    </div>
  );
};

export const OmlxSetupCard = ({ status, checking, onRecheck, endpointUrl, onEndpointUrlChange, onAutoInstall }: OmlxSetupCardProps) => {
  const { t } = useTranslation();

  if (!status) {
    return (
      <Card className="border-muted">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">{t('ONBOARDING_OMLX_CHECKING')}</div>
              <div className="text-xs text-muted-foreground">{t('ONBOARDING_OMLX_LOOKING_HOST')}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status.ready) {
    const endpoint = status.displayEndpoint ?? status.endpointUrl;

    return (
      <Card className="border-success/30 bg-success/10">
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-success">{t('ONBOARDING_OMLX_DETECTED')}</div>
                <div className="text-xs text-success">{endpoint}</div>
              </div>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={onRecheck}
              loading={checking}
              aria-label={t('ONBOARDING_OMLX_RECHECK')}
              data-testid="omlx-recheck-btn"
              className="shrink-0"
            >
              {!checking && <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <OmlxConnectionFields
            endpointUrl={endpointUrl}
            onEndpointUrlChange={onEndpointUrlChange}
            labelClass="text-success"
            hintClass="text-success"
            defaultEndpointUrl={status.endpointUrl}
            idSuffix="ready"
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden border-warning/30 bg-warning/10">
      <CardContent className="min-w-0 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Download className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-sm font-medium text-warning">{t('ONBOARDING_OMLX_NOT_DETECTED')}</div>
            <div className="mb-3 text-xs text-warning">{status.hint ?? t('ONBOARDING_OMLX_NOT_DETECTED_DESC')}</div>
            {status.error && <OmlxProbeError error={status.error} />}
            {status.remediationCommand && (
              <div className="mb-3 min-w-0" data-testid="omlx-remediation-command">
                <div className="mb-1 text-xs font-medium text-warning">{t('ONBOARDING_OLLAMA_RUN_ON_HOST')}</div>
                <code className="block w-full max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded bg-warning/10 px-2 py-1.5 text-xs text-warning">
                  {status.remediationCommand}
                </code>
              </div>
            )}
            <div className="mb-3">
              <OmlxConnectionFields
                endpointUrl={endpointUrl}
                onEndpointUrlChange={onEndpointUrlChange}
                labelClass="text-warning"
                hintClass="text-warning"
                defaultEndpointUrl={status.endpointUrl}
                idSuffix="unready"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {onAutoInstall && <AutoInstallRunnerButton onRun={onAutoInstall} />}
              <Button size="sm" variant="ghost" onClick={() => openExternal(OMLX_DOCS_URL)}>
                {t('ONBOARDING_OMLX_DOCS')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onRecheck} loading={checking} data-testid="omlx-recheck-btn">
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                {t('ONBOARDING_OMLX_RECHECK')}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
