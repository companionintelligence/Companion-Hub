import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import type { RegistrationStateDrift, StateDriftSignal } from '@/lib/registration-state-drift';
import { cn } from '@/lib/utils';
import { Laptop, PlusCircle, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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

function secondarySignals(drift: RegistrationStateDrift): StateDriftSignal[] {
  return drift.signals.filter((signal) => signal.reason !== 'local_unregistered_portal_active');
}

type DriftOptionCardProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  recommended?: boolean;
  testId: string;
  variant?: 'primary' | 'outline';
};

function DriftOptionCard({
  icon: Icon,
  title,
  description,
  actionLabel,
  onClick,
  disabled,
  loading,
  recommended,
  testId,
  variant = 'outline',
}: DriftOptionCardProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        'flex h-full flex-col rounded-xl border bg-card p-5 sm:p-6 transition-colors',
        recommended ? 'border-primary/50 ring-1 ring-primary/20 shadow-sm' : 'border-border/60',
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
            recommended ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-semibold leading-snug text-foreground">{title}</p>
            {recommended ? (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-primary">
                {t('DEVICE_REGISTRATION_STATE_DRIFT_RECOMMENDED')}
              </span>
            ) : null}
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>

      <Button
        className="mt-6 w-full"
        intent={variant === 'primary' ? 'primary' : undefined}
        variant={variant === 'primary' ? undefined : 'outline'}
        onClick={onClick}
        disabled={disabled}
        loading={loading}
        data-testid={testId}
      >
        {actionLabel}
      </Button>
    </div>
  );
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
  const recommendRestore = drift?.portalDeviceActive === true;
  const extraSignals = drift ? secondarySignals(drift) : [];

  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent
        size="lg"
        className="gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <div className="space-y-5 px-6 pb-2 pt-6 sm:px-8 sm:pt-8">
          <DialogHeader className="space-y-2 text-left">
            <div className="flex items-center gap-2 text-primary">
              <Laptop className="h-5 w-5 shrink-0" aria-hidden />
              <span className="text-xs font-medium uppercase tracking-wide">{t('DEVICE_REGISTRATION_STATE_DRIFT_EYEBROW')}</span>
            </div>
            <DialogTitle className="text-xl font-semibold leading-tight sm:text-2xl">{t('DEVICE_REGISTRATION_STATE_DRIFT_TITLE')}</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed sm:text-[15px]">
              {t('DEVICE_REGISTRATION_STATE_DRIFT_DESCRIPTION')}
            </DialogDescription>
          </DialogHeader>

          {recommendRestore ? (
            <Alert variant="info" className="mb-0">
              <AlertDescription className="text-sm leading-relaxed">{t('DEVICE_REGISTRATION_STATE_DRIFT_PORTAL_ACTIVE')}</AlertDescription>
            </Alert>
          ) : null}

          {extraSignals.length > 0 ? (
            <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('DEVICE_REGISTRATION_STATE_DRIFT_DETAILS_HEADING')}
              </p>
              <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                {extraSignals.map((signal) => (
                  <li key={`${signal.reason}-${signal.detail ?? ''}`}>{signalCopy(signal, t)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 px-6 py-6 sm:px-8 md:grid-cols-2">
          <DriftOptionCard
            icon={RefreshCw}
            title={t('DEVICE_REGISTRATION_STATE_DRIFT_RESTORE')}
            description={t('DEVICE_REGISTRATION_STATE_DRIFT_RESTORE_HINT')}
            actionLabel={t('DEVICE_REGISTRATION_STATE_DRIFT_RESTORE_ACTION')}
            onClick={onRestore}
            disabled={isPreparing}
            recommended={recommendRestore}
            variant={recommendRestore ? 'primary' : 'outline'}
            testId="drift-restore"
          />

          <DriftOptionCard
            icon={PlusCircle}
            title={t('DEVICE_REGISTRATION_STATE_DRIFT_SETUP_NEW')}
            description={t('DEVICE_REGISTRATION_STATE_DRIFT_SETUP_NEW_HINT')}
            actionLabel={isPreparing ? t('DEVICE_REGISTRATION_STATE_DRIFT_PREPARING') : t('DEVICE_REGISTRATION_STATE_DRIFT_SETUP_NEW_ACTION')}
            onClick={onSetupNew}
            disabled={isPreparing}
            loading={isPreparing}
            recommended={!recommendRestore}
            variant={recommendRestore ? 'outline' : 'primary'}
            testId="drift-setup-new"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RegistrationRestoreBanner() {
  const { t } = useTranslation();

  return (
    <Alert variant="info">
      <AlertDescription className="text-sm leading-relaxed">{t('DEVICE_REGISTRATION_STATE_DRIFT_RESTORE_BANNER')}</AlertDescription>
    </Alert>
  );
}
