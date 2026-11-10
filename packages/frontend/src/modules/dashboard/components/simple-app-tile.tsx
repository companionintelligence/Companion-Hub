import type React from 'react';
import { AppLogo } from '@/components/app-logo/app-logo';
import { restartCanApply } from '@/lib/cloudflare-api';
import { InstallRetryButton } from '@/modules/app/components/install-retry-button/install-retry-button';
import { Loader2, LockOpen, PowerOff, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PortExposeOpenTo } from '@/modules/app/helpers/port-expose-open-to';
import type { AppStatus } from '@/types/app.types';

const STOPPED_STATUSES: AppStatus[] = ['stopped', 'missing'];
const INSTALL_FAILED_STATUS: AppStatus = 'install_failed';

interface SimpleAppTileProps {
  name: string;
  urn: string;
  status?: AppStatus;
  isInstalling?: boolean;
  installConfig?: Record<string, unknown>;
  /** The app's compose env is stale until it is restarted. */
  pendingRestart?: boolean;
  /** The stale env is keeping a bound custom domain dark, which is worth naming. */
  customDomainAwaitingRestart?: string;
  /** One muted line under the name. The guest dashboard shows it; Home does not. */
  description?: string;
  /** An image to show instead of the app's catalog image, such as a link's icon. */
  logoUrl?: string;
  /** Drawn at the end of the row, such as the mark that a link opens another site. */
  trailing?: React.ReactNode;
  /** An exposed port that has no Hub sign-in in front of it, and who can open it (`portExposeOpenTo`). */
  openWithoutSignIn?: PortExposeOpenTo | null;
}

export const SimpleAppTile = ({
  name,
  urn,
  status,
  isInstalling,
  installConfig,
  pendingRestart,
  customDomainAwaitingRestart,
  description,
  logoUrl,
  trailing,
  openWithoutSignIn,
}: SimpleAppTileProps) => {
  const { t } = useTranslation();
  const isInstallFailed = status === INSTALL_FAILED_STATUS;
  const isStopped = status != null && STOPPED_STATUSES.includes(status);
  const hasOverlay = isInstalling || isInstallFailed;
  const [slug] = urn.split(':');
  /*
   * ONLY A RUNNING APP IS ASKED TO RESTART — `restartCanApply` is the same rule the
   * banner and its click guard use, so the two surfaces cannot disagree about the
   * same app on the same screen.
   *
   * Listing the statuses that DON'T qualify was the trap: a stopped app needs no
   * restart (`start-app-command` regenerates the env on the way up), but neither
   * does one already starting, restarting, updating, resetting or restoring, and
   * badging an app mid-uninstall asks the operator to fix something being deleted.
   * A badge that asks for pointless work is how the last one came to be ignored.
   */
  const showPendingRestart = Boolean(pendingRestart) && restartCanApply(status);
  const openLabel = openWithoutSignIn
    ? t(openWithoutSignIn === 'anyone' ? 'PORT_EXPOSE_OPEN_TO_ANYONE_NO_SIGN_IN' : 'PORT_EXPOSE_OPEN_TO_TAILNET_NO_SIGN_IN')
    : '';
  const pendingRestartLabel = showPendingRestart
    ? customDomainAwaitingRestart
      ? t('MY_APPS_PENDING_RESTART_CUSTOM_DOMAIN', { domain: customDomainAwaitingRestart })
      : t('MY_APPS_PENDING_RESTART')
    : '';

  return (
    <div className="flex items-center gap-3 p-2 cursor-pointer hover:opacity-80 transition-opacity w-full rounded-md hover:bg-muted/40">
      <div className="relative flex-shrink-0">
        <AppLogo urn={urn || undefined} url={logoUrl} alt={name} size={44} className={`rounded-md shadow-sm${hasOverlay ? ' opacity-40' : ''}`} />
        {isInstalling && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-primary animate-spin" />
          </div>
        )}
        {isInstallFailed && slug && <InstallRetryButton urn={urn} name={name} slug={slug} config={installConfig} />}
        {isStopped && !isInstalling && !isInstallFailed && (
          <div
            className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 rounded-full bg-red-500 shadow-sm"
            data-testid="app-stopped-badge"
            title={t('APP_STATUS_STOPPED')}
          >
            <PowerOff className="w-3 h-3 text-white" strokeWidth={2.5} aria-hidden />
            <span className="sr-only">{t('APP_STATUS_STOPPED')}</span>
          </div>
        )}
        {showPendingRestart && (
          <div
            className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 rounded-full bg-warning shadow-sm"
            data-testid="app-pending-restart-badge"
            title={pendingRestartLabel}
          >
            <RotateCw className="w-3 h-3 text-warning-foreground" strokeWidth={2.5} aria-hidden />
            {/*
             * A short token, not the whole sentence. The tile is wrapped in a `<Link>`,
             * so anything here joins that link's accessible name — spelling out
             * "wp.example.com will not serve this app until it is restarted" would bury
             * the app's own name, the one thing that tells two tiles apart. The full
             * sentence stays on `title` for a sighted hover, as the Stopped badge does.
             */}
            <span className="sr-only">{t('MY_APPS_PENDING_RESTART_BADGE_LABEL')}</span>
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm text-foreground" title={name}>
          {name}
        </div>
        {description ? (
          <div className="truncate text-xs text-muted-foreground" title={description}>
            {description}
          </div>
        ) : null}
        {/* A line under the name, not a badge on the logo: those ask for something, and this only reminds. */}
        {openLabel ? (
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" data-testid="app-open-without-sign-in" title={openLabel}>
            <LockOpen className="size-3 shrink-0 text-warning" aria-hidden />
            <span className="truncate">{openLabel}</span>
          </div>
        ) : null}
        {isInstalling && (
          <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary rounded-full  w-2/3" />
          </div>
        )}
      </div>
      {trailing}
    </div>
  );
};
