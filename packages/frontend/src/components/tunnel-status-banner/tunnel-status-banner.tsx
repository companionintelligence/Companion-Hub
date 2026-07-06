import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { requiresPortalRePairing } from '@/lib/registration-status';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

/**
 * Hub-wide banner surfaced when the device is registered but its public tunnel
 * is degraded (tunnel_token_missing). The Hub still works locally, so instead
 * of redirecting the user to the re-pair screen (see root.tsx clientLoader) we
 * inform them here and offer a one-click path to re-pair when they're ready.
 */
export function TunnelStatusBanner() {
  const { t } = useTranslation();
  const { data: status } = useRegistrationStatus();

  if (!status || !requiresPortalRePairing(status)) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="tunnel-status-banner"
      className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm shadow-sm md:flex-row md:items-center md:justify-between"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <span className="leading-relaxed text-foreground">
          <strong className="font-semibold text-amber-700 dark:text-amber-400">{t('TUNNEL_DEGRADED_BANNER_TITLE')}</strong>{' '}
          <span className="text-muted-foreground">— {t('TUNNEL_DEGRADED_BANNER_MESSAGE')}</span>
        </span>
      </div>
      <Link
        to="/device-registration"
        className="shrink-0 self-start rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:self-auto"
      >
        {t('TUNNEL_DEGRADED_BANNER_ACTION')}
      </Link>
    </div>
  );
}
