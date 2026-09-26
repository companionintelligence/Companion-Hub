import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { fetchManualEndpointStatus } from '@/lib/inference/inference-api';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ManualEndpointsCardProps {
  decodeEndpoint: string;
  encodeEndpoint: string;
  onDecodeEndpointChange: (value: string) => void;
  onEncodeEndpointChange: (value: string) => void;
}

export const ManualEndpointsCard = ({ decodeEndpoint, encodeEndpoint, onDecodeEndpointChange, onEncodeEndpointChange }: ManualEndpointsCardProps) => {
  const { t } = useTranslation();
  const [checking, setChecking] = useState<'decode' | 'encode' | null>(null);
  const [decodeResult, setDecodeResult] = useState<string | null>(null);
  const [encodeResult, setEncodeResult] = useState<string | null>(null);

  const recheck = async (which: 'decode' | 'encode') => {
    const url = (which === 'decode' ? decodeEndpoint : encodeEndpoint).trim();
    const setResult = which === 'decode' ? setDecodeResult : setEncodeResult;
    if (!url) {
      setResult(null);
      return;
    }
    setChecking(which);
    try {
      const status = (await fetchManualEndpointStatus(url)) as { ready?: boolean; displayEndpoint?: string; endpointUrl?: string; error?: string };
      const shown = status.displayEndpoint ?? status.endpointUrl ?? url;
      setResult(status.ready ? shown : (status.error ?? t('ONBOARDING_MANUAL_ENDPOINT_UNREACHABLE')));
    } catch (error) {
      setResult(error instanceof Error ? error.message : t('ONBOARDING_MANUAL_ENDPOINT_UNREACHABLE'));
    } finally {
      setChecking(null);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
      <div>
        <h2 className="text-base font-bold uppercase tracking-wide">{t('ONBOARDING_MANUAL_ENDPOINTS_TITLE')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">{t('ONBOARDING_MANUAL_ENDPOINTS_DESC')}</p>
      </div>
      <div className="space-y-4">
        <div className="min-w-0">
          <label htmlFor="manual-decode-endpoint" className="mb-1 block text-xs font-medium">
            {t('ONBOARDING_MANUAL_DECODE_LABEL')}
          </label>
          <div className="flex w-full min-w-0 items-start gap-2">
            <Input
              id="manual-decode-endpoint"
              value={decodeEndpoint}
              onChange={(event) => onDecodeEndpointChange(event.target.value)}
              placeholder="http://host.docker.internal:8000"
              data-testid="manual-decode-endpoint"
              className="min-w-0 w-full flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              loading={checking === 'decode'}
              aria-label={t('ONBOARDING_OMLX_RECHECK')}
              onClick={() => void recheck('decode')}
            >
              {checking !== 'decode' && <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="manual-decode-hint">
            {t('ONBOARDING_MANUAL_DECODE_HINT')}
          </p>
          {decodeResult && <p className="mt-1 break-all text-xs text-muted-foreground">{decodeResult}</p>}
        </div>
        <div className="min-w-0">
          <label htmlFor="manual-encode-endpoint" className="mb-1 block text-xs font-medium">
            {t('ONBOARDING_MANUAL_ENCODE_LABEL')}
          </label>
          <div className="flex w-full min-w-0 items-start gap-2">
            <Input
              id="manual-encode-endpoint"
              value={encodeEndpoint}
              onChange={(event) => onEncodeEndpointChange(event.target.value)}
              placeholder="http://host.docker.internal:11434"
              data-testid="manual-encode-endpoint"
              className="min-w-0 w-full flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              loading={checking === 'encode'}
              aria-label={t('ONBOARDING_OMLX_RECHECK')}
              onClick={() => void recheck('encode')}
            >
              {checking !== 'encode' && <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="manual-encode-hint">
            {t('ONBOARDING_MANUAL_ENCODE_HINT')}
          </p>
          {encodeResult && <p className="mt-1 break-all text-xs text-muted-foreground">{encodeResult}</p>}
        </div>
      </div>
    </section>
  );
};
