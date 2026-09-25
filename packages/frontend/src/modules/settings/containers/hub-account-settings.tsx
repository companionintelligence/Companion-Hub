import { resetRegistration } from '@/api-client/sdk.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { clearClientHubState } from '@/lib/clear-client-hub-state';
import { openExternal } from '@/lib/helpers/open-external';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import { type HubRemovalWatchEnd, portalRemoveDeviceUrl, watchForHubRemoval } from '@/lib/hub-removal-watch';
import { portalConfigQueryOptions } from '@/lib/portal-config';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Unlink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SectionHeader } from '../components/network-section/network-section';

const PAIRING_ROUTE = '/device-registration';
const REDIRECT_DELAY_MS = 1500;

type WatchState = 'idle' | 'watching' | Exclude<HubRemovalWatchEnd, 'removed' | 'timed_out'>;

function goToPairing() {
  clearClientHubState({ keepPortalEmail: true });
  setTimeout(() => {
    window.location.href = PAIRING_ROUTE;
  }, REDIRECT_DELAY_MS);
}

/**
 * Two ways to take this Hub off an account, kept apart because they do different things.
 *
 * Removing it happens in the Portal, where an owner or admin deletes the device and with it the
 * device's web addresses and apps. The Hub cannot do that on its own: its device key is also held
 * by first-party apps, so the Portal does not accept it for removal. Settings opens the Portal and
 * then watches for the Hub's check-in to report the removal, which resets the Hub.
 *
 * Resetting only clears the pairing on this Hub. The Portal keeps the device.
 */
export const HubAccountSection = () => {
  const { t } = useTranslation();
  const demoMode = useDemoMode();
  const { data: portalConfig } = useQuery(portalConfigQueryOptions());
  const [watchState, setWatchState] = useState<WatchState>('idle');
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const stopWatchRef = useRef<(() => void) | null>(null);

  const removeUrl = portalConfig?.portalUrl && portalConfig.deviceId ? portalRemoveDeviceUrl(portalConfig.portalUrl, portalConfig.deviceId) : null;

  const stopWatch = useCallback(() => {
    stopWatchRef.current?.();
    stopWatchRef.current = null;
  }, []);

  useEffect(() => stopWatch, [stopWatch]);

  const handleWatchEnd = useCallback(
    (end: HubRemovalWatchEnd) => {
      stopWatchRef.current = null;

      if (end === 'removed') {
        setWatchState('idle');
        toast.success(t('SETTINGS_HUB_ACCOUNT_REMOVED'));
        goToPairing();
        return;
      }

      // A timeout is not an error: the person may still be in the Portal, or changed their mind.
      setWatchState(end === 'timed_out' ? 'idle' : end);
    },
    [t],
  );

  const handleRemove = () => {
    if (!removeUrl) {
      return;
    }
    if (demoMode) {
      toast.error(t('SERVER_ERROR_NOT_ALLOWED_IN_DEMO'));
      return;
    }

    // Opened before anything is awaited, so a browser still counts it as part of the click.
    void openExternal(removeUrl);

    stopWatch();
    setWatchState('watching');
    stopWatchRef.current = watchForHubRemoval({ onEnd: handleWatchEnd });
  };

  const handleCancelWatch = () => {
    stopWatch();
    setWatchState('idle');
  };

  const handleReset = async () => {
    if (demoMode) {
      toast.error(t('SERVER_ERROR_NOT_ALLOWED_IN_DEMO'));
      return;
    }
    setResetConfirmOpen(false);
    setIsResetting(true);
    try {
      const result = await resetRegistration();
      if (result.error) {
        toast.error(t('SETTINGS_NETWORK_RESET_REGISTRATION_ERROR'));
        return;
      }
      stopWatch();
      toast.success(t('SETTINGS_NETWORK_RESET_REGISTRATION_SUCCESS'));
      goToPairing();
    } catch {
      toast.error(t('SETTINGS_NETWORK_RESET_REGISTRATION_ERROR'));
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <Card data-testid="hub-account-card">
      <SectionHeader icon={Unlink} title={t('SETTINGS_HUB_ACCOUNT_TITLE')} />
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{t('SETTINGS_HUB_ACCOUNT_REMOVE_TITLE')}</p>
            <p className="text-xs text-muted-foreground">{t('SETTINGS_HUB_ACCOUNT_REMOVE_DESC')}</p>

            {watchState === 'watching' && (
              <div
                role="status"
                aria-live="polite"
                className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs"
                data-testid="remove-hub-waiting"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  {t('SETTINGS_HUB_ACCOUNT_REMOVE_WAITING')}
                </span>
                {removeUrl && (
                  <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => void openExternal(removeUrl)}>
                    {t('SETTINGS_HUB_ACCOUNT_REMOVE_OPEN_AGAIN')}
                  </button>
                )}
                <button type="button" className="text-muted-foreground underline-offset-2 hover:underline" onClick={handleCancelWatch}>
                  {t('SETTINGS_HUB_ACCOUNT_REMOVE_STOP')}
                </button>
              </div>
            )}

            {(watchState === 'key_refused' || watchState === 'not_allowed') && (
              <p
                role="alert"
                className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-warning"
                data-testid="remove-hub-stopped"
              >
                {t(watchState === 'key_refused' ? 'SETTINGS_HUB_ACCOUNT_REMOVE_KEY_REFUSED' : 'SETTINGS_HUB_ACCOUNT_REMOVE_NOT_ALLOWED')}
              </p>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            intent="danger"
            variant="outline"
            className="shrink-0"
            disabled={demoMode || !removeUrl}
            onClick={handleRemove}
            data-testid="remove-hub-from-account-btn"
          >
            {t('SETTINGS_HUB_ACCOUNT_REMOVE_BUTTON')}
          </Button>
        </div>

        <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{t('SETTINGS_HUB_ACCOUNT_RESET_TITLE')}</p>
            <p className="text-xs text-muted-foreground">{t('SETTINGS_HUB_ACCOUNT_RESET_DESC')}</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={demoMode}
            loading={isResetting}
            onClick={() => setResetConfirmOpen(true)}
            data-testid="reregister-device-btn"
          >
            {isResetting ? t('SETTINGS_NETWORK_RESETTING') : t('SETTINGS_HUB_ACCOUNT_RESET_BUTTON')}
          </Button>
        </div>
      </CardContent>

      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent type="danger" size="sm">
          <DialogHeader>
            <DialogTitle>{t('SETTINGS_HUB_ACCOUNT_RESET_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="py-2">{t('SETTINGS_HUB_ACCOUNT_RESET_CONFIRM')}</DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResetConfirmOpen(false)} disabled={isResetting}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button intent="danger" loading={isResetting} onClick={handleReset} data-testid="reregister-confirm-btn">
              {t('SETTINGS_HUB_ACCOUNT_RESET_BUTTON')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
