import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import {
  allowLocalAiOnNetwork,
  fetchLocalAiNetworkExposure,
  type LocalAiNetworkExposure,
  localAiNetworkState,
  protectLocalAi,
} from '@/lib/inference/local-ai-exposure';
import { ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Whether other devices on the network can use this computer's AI servers, and the switch for it.
 * The desktop's network guard is on by default; turning it off is remembered, and then this says so
 * quietly instead of warning. Shown only in the desktop app, where the guard applies (Linux, a WSL
 * engine). Renders nothing elsewhere.
 */
export const LocalAiExposureNotice = () => {
  const { t } = useTranslation();
  const [exposure, setExposure] = useState<LocalAiNetworkExposure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setExposure(await fetchLocalAiNetworkExposure());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const state = localAiNetworkState(exposure);
  if (state === 'none') return null;

  const errorLine = error && (
    <p className="mt-2 text-xs text-destructive" role="status">
      {error}
    </p>
  );

  if (state === 'exposed') {
    return (
      <Alert variant="warning" className="mt-3" data-testid="local-ai-exposure-notice">
        <AlertIcon>
          <ShieldAlert />
        </AlertIcon>
        <div>
          <AlertHeading className="text-sm">{t('LOCAL_AI_EXPOSED_TITLE')}</AlertHeading>
          <AlertDescription className="text-xs">
            <p>{t('LOCAL_AI_EXPOSED_DESCRIPTION')}</p>
            {exposure?.canProtect ? (
              <Button variant="outline" size="sm" className="mt-2" onClick={() => void run(protectLocalAi)} loading={busy}>
                {t('LOCAL_AI_EXPOSED_PROTECT')}
              </Button>
            ) : (
              <p className="mt-1">{t('LOCAL_AI_EXPOSED_MANUAL')}</p>
            )}
            {errorLine}
          </AlertDescription>
        </div>
      </Alert>
    );
  }

  const guarded = state === 'guarded';
  return (
    <div className="mt-3 border-t border-success/20 pt-3 text-xs" data-testid="local-ai-network-setting">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          {guarded ? <ShieldCheck className="h-3.5 w-3.5 shrink-0" /> : <ShieldOff className="h-3.5 w-3.5 shrink-0" />}
          <span>{t(guarded ? 'LOCAL_AI_GUARDED' : 'LOCAL_AI_OPEN_BY_CHOICE')}</span>
        </div>
        {exposure?.canProtect && (
          <Button variant="ghost" size="sm" onClick={() => void run(guarded ? allowLocalAiOnNetwork : protectLocalAi)} loading={busy}>
            {t(guarded ? 'LOCAL_AI_ALLOW_NETWORK' : 'LOCAL_AI_EXPOSED_PROTECT')}
          </Button>
        )}
      </div>
      {errorLine}
    </div>
  );
};
