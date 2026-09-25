import { getStatusQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { reconnectTunnel, resetRegistrationForRePair } from '@/lib/registration-api';
import { requiresPortalRePairing } from '@/lib/registration-status';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

/**
 * Hub-wide banner surfaced when the device is registered but its public tunnel
 * is degraded (tunnel_token_missing). The Hub still works locally, so instead of
 * redirecting the user off the app (see root.tsx clientLoader) we inform them
 * here and offer a one-click "Reconnect" that recovers the already-provisioned
 * tunnel credentials. Only when there is nothing to recover do we route to a
 * genuine re-pair — pairing is refused for an already-registered device, so a
 * plain link to the pairing screen would dead-end with "Device is already registered".
 */
export function TunnelStatusBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: status } = useRegistrationStatus();
  const [isReconnecting, setIsReconnecting] = useState(false);

  if (!status || !requiresPortalRePairing(status)) {
    return null;
  }

  const handleReconnect = async () => {
    setIsReconnecting(true);
    try {
      const result = await reconnectTunnel();
      if (result.recovered) {
        toast.success(t('TUNNEL_DEGRADED_RECONNECT_SUCCESS'));
        await queryClient.invalidateQueries({ queryKey: getStatusQueryKey() });
        return;
      }
      if (result.action === 're_pair') {
        // No recoverable credentials — re-pairing requires resetting local
        // registration first (the backend refuses a pairing code while registered).
        // That is destructive, so confirm before wiping the device's registration.
        if (!window.confirm(t('TUNNEL_DEGRADED_REPAIR_CONFIRM'))) {
          return;
        }
        const reset = await resetRegistrationForRePair();
        if (reset.ok) {
          toast.warning(t('TUNNEL_DEGRADED_RECONNECT_NEEDS_REPAIR'), { duration: 8000 });
          navigate('/device-registration');
        } else {
          toast.error(t('TUNNEL_DEGRADED_RECONNECT_FAILED'));
        }
        return;
      }
      if (result.action === 'restart') {
        // Credentials exist but the token file could not be written (tunnel dir
        // not writable). A restart lets the container entrypoint heal ownership.
        toast.warning(t('TUNNEL_DEGRADED_RECONNECT_NEEDS_RESTART'), { duration: 8000 });
        return;
      }
      toast.error(t('TUNNEL_DEGRADED_RECONNECT_FAILED'));
    } finally {
      setIsReconnecting(false);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="tunnel-status-banner"
      className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm shadow-sm md:flex-row md:items-center md:justify-between"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <span className="leading-relaxed text-foreground">
          <strong className="font-semibold text-warning">{t('TUNNEL_DEGRADED_BANNER_TITLE')}</strong>
          <span className="text-muted-foreground"> {t('TUNNEL_DEGRADED_BANNER_MESSAGE')}</span>
        </span>
      </div>
      <button
        type="button"
        onClick={() => void handleReconnect()}
        disabled={isReconnecting}
        className="shrink-0 self-start rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 md:self-auto"
      >
        {isReconnecting ? t('TUNNEL_DEGRADED_BANNER_ACTION_PENDING') : t('TUNNEL_DEGRADED_BANNER_ACTION')}
      </button>
    </div>
  );
}
