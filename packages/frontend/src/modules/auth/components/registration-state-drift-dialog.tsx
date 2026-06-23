import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import type { RegistrationStateDrift, StateDriftSignal } from '@/lib/registration-state-drift';
import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

function signalCopy(signal: StateDriftSignal, t: (key: string, options?: Record<string, string>) => string) {
  switch (signal.reason) {
    case 'local_unregistered_portal_active':
      return t('DEVICE_REGISTRATION_STATE_DRIFT_PORTAL_ACTIVE');
    case 'stale_hub_device_id_in_app_data':
      return t('DEVICE_REGISTRATION_STATE_DRIFT_STALE_APP_DATA', { deviceId: signal.detail ?? 'unknown' });
    case 'stale_tunnel_token':
      return t('DEVICE_REGISTRATION_STATE_DRIFT_STALE_TUNNEL');
    case 'orphaned_local_db_registration':
      return t('DEVICE_REGISTRATION_STATE_DRIFT_ORPHANED_DB');
    default:
      return signal.detail ?? signal.reason;
  }
}

type RegistrationStateDriftDialogProps = {
  open: boolean;
  drift: RegistrationStateDrift | null;
  isPreparing: boolean;
  onSetupNew: () => void;
  onRestore: () => void;
};

export function RegistrationStateDriftDialog({ open, drift, isPreparing, onSetupNew, onRestore }: RegistrationStateDriftDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent size="md" onPointerDownOutside={(event) => event.preventDefault()} onEscapeKeyDown={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t('DEVICE_REGISTRATION_STATE_DRIFT_TITLE')}</DialogTitle>
          <DialogDescription>{t('DEVICE_REGISTRATION_STATE_DRIFT_DESCRIPTION')}</DialogDescription>
        </DialogHeader>

        {drift?.signals.length ? (
          <ul className="space-y-2 text-sm text-muted-foreground">
            {drift.signals.map((signal) => (
              <li key={`${signal.reason}-${signal.detail ?? ''}`} className="flex items-start gap-2">
                <AlertCircle role="img" aria-label={t('COMMON_WARNING')} className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <span>{signalCopy(signal, t)}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
            <p className="text-sm font-semibold text-foreground">{t('DEVICE_REGISTRATION_STATE_DRIFT_SETUP_NEW')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('DEVICE_REGISTRATION_STATE_DRIFT_SETUP_NEW_HINT')}</p>
            <Button
              className="mt-4 w-full"
              intent="primary"
              onClick={onSetupNew}
              disabled={isPreparing}
              loading={isPreparing}
              data-testid="drift-setup-new"
            >
              {isPreparing ? t('DEVICE_REGISTRATION_STATE_DRIFT_PREPARING') : t('DEVICE_REGISTRATION_STATE_DRIFT_SETUP_NEW')}
            </Button>
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
            <p className="text-sm font-semibold text-foreground">{t('DEVICE_REGISTRATION_STATE_DRIFT_RESTORE')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('DEVICE_REGISTRATION_STATE_DRIFT_RESTORE_HINT')}</p>
            <Button className="mt-4 w-full" variant="outline" onClick={onRestore} disabled={isPreparing} data-testid="drift-restore">
              {t('DEVICE_REGISTRATION_STATE_DRIFT_RESTORE')}
            </Button>
          </div>
        </div>

        <DialogFooter className="hidden" />
      </DialogContent>
    </Dialog>
  );
}

export function RegistrationRestoreBanner() {
  const { t } = useTranslation();

  return (
    <Alert variant="info">
      <AlertDescription>{t('DEVICE_REGISTRATION_STATE_DRIFT_RESTORE_BANNER')}</AlertDescription>
    </Alert>
  );
}
