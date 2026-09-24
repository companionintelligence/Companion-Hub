import { AppLogo } from '@/components/app-logo/app-logo';
import { InstallRetryButton } from '@/modules/app/components/install-retry-button/install-retry-button';
import { Loader2, PowerOff, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  customDomainAwaitingRestart?: string | null;
}

export const SimpleAppTile = ({
  name,
  urn,
  status,
  isInstalling,
  installConfig,
  pendingRestart,
  customDomainAwaitingRestart,
}: SimpleAppTileProps) => {
  const { t } = useTranslation();
  const isInstallFailed = status === INSTALL_FAILED_STATUS;
  const isStopped = status != null && STOPPED_STATUSES.includes(status);
  const hasOverlay = isInstalling || isInstallFailed;
  const [slug] = urn.split(':');
  /*
   * A STOPPED APP NEEDS NO RESTART, so it gets no badge. `start-app-command`
   * regenerates the env on the way up, which is the very thing the badge would be
   * asking for. Badging it would send an operator to perform a fix that is already
   * scheduled — and a badge that asks for pointless work is how the last one came
   * to be ignored.
   *
   * Nothing is claimed during an install either: the env is mid-flight and the
   * tile is already saying so.
   */
  const showPendingRestart = Boolean(pendingRestart) && !isStopped && !hasOverlay;
  const pendingRestartLabel = customDomainAwaitingRestart
    ? t('MY_APPS_PENDING_RESTART_CUSTOM_DOMAIN', { domain: customDomainAwaitingRestart })
    : t('MY_APPS_PENDING_RESTART');

  return (
    <div className="flex items-center gap-3 p-2 cursor-pointer hover:opacity-80 transition-opacity w-full rounded-md hover:bg-muted/40">
      <div className="relative flex-shrink-0">
        <AppLogo urn={urn} alt={name} size={44} className={`rounded-md shadow-sm${hasOverlay ? ' opacity-40' : ''}`} />
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
            title="Stopped"
          >
            <PowerOff className="w-3 h-3 text-white" strokeWidth={2.5} aria-hidden />
            <span className="sr-only">Stopped</span>
          </div>
        )}
        {showPendingRestart && (
          <div
            className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 rounded-full bg-warning shadow-sm"
            data-testid="app-pending-restart-badge"
            title={pendingRestartLabel}
          >
            <RotateCw className="w-3 h-3 text-warning-foreground" strokeWidth={2.5} aria-hidden />
            <span className="sr-only">{pendingRestartLabel}</span>
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm text-foreground" title={name}>
          {name}
        </div>
        {isInstalling && (
          <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary rounded-full animate-pulse w-2/3" />
          </div>
        )}
      </div>
    </div>
  );
};
