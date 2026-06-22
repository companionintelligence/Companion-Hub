import { AppLogo } from '@/components/app-logo/app-logo';
import { InstallRetryButton } from '@/modules/app/components/install-retry-button/install-retry-button';
import { Loader2, X } from 'lucide-react';
import type { AppStatus } from '@/types/app.types';

const FAILED_STATUSES: AppStatus[] = ['stopped', 'missing'];
const INSTALL_FAILED_STATUS: AppStatus = 'install_failed';

interface SimpleAppTileProps {
  name: string;
  urn: string;
  status?: AppStatus;
  isInstalling?: boolean;
  installConfig?: Record<string, unknown>;
}

export const SimpleAppTile = ({ name, urn, status, isInstalling, installConfig }: SimpleAppTileProps) => {
  const isInstallFailed = status === INSTALL_FAILED_STATUS;
  const isFailed = status != null && FAILED_STATUSES.includes(status);
  const hasOverlay = isInstalling || isFailed || isInstallFailed;
  const [slug] = urn.split(':');

  return (
    <div className="flex items-center gap-3 p-2 cursor-pointer hover:opacity-80 transition-opacity w-full rounded-xl hover:bg-muted/40">
      <div className="relative flex-shrink-0">
        <AppLogo urn={urn} alt={name} size={44} className={`rounded-xl shadow-sm${hasOverlay ? ' opacity-40' : ''}`} />
        {isInstalling && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-primary animate-spin" />
          </div>
        )}
        {isInstallFailed && slug && <InstallRetryButton urn={urn} name={name} slug={slug} config={installConfig} />}
        {isFailed && !isInstalling && !isInstallFailed && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex items-center justify-center w-6 h-6 rounded-full bg-red-500/90">
              <X className="w-4 h-4 text-white" strokeWidth={3} />
            </div>
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm" title={name}>
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
