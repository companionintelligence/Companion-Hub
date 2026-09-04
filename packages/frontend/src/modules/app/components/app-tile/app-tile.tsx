import { AppLogo } from '@/components/app-logo/app-logo';
import { Card, CardContent } from '@/components/ui/Card';
import { limitText } from '@/lib/helpers/text-helpers';
import type { AppInfo, AppStatus as AppStatusType } from '@/types/app.types';
import { InstallRetryButton } from '../install-retry-button/install-retry-button';
import { AlertCircle, CloudOff, Download, RotateCw } from 'lucide-react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from 'react-tooltip';
import { AppStatus } from '../app-status/app-status';
import './app-tile.css';

type AppTileInfo = Pick<AppInfo, 'urn' | 'name' | 'short_desc' | 'deprecated'>;

export const AppTile: React.FC<{
  info: AppTileInfo;
  status: AppStatusType;
  updateAvailable: boolean;
  pendingRestart?: boolean;
  available?: boolean;
  installConfig?: Record<string, unknown>;
}> = ({ info, status, updateAvailable, pendingRestart, available = true, installConfig }) => {
  const { t } = useTranslation();

  let badge = null;

  if (!available) {
    badge = (
      <>
        <Tooltip className="tooltip" anchorSelect=".storeUnavailable">
          {t('MY_APPS_STORE_UNAVAILABLE')}
        </Tooltip>
        <div
          className="storeUnavailable absolute top-0 right-0 rounded-tr-lg rounded-bl-lg bg-gray-500 text-white p-1.5"
          data-testid="badge-unavailable"
        >
          <CloudOff size={20} />
        </div>
      </>
    );
  } else if (pendingRestart) {
    badge = (
      <>
        <Tooltip className="tooltip" anchorSelect=".pendingRestart">
          {t('MY_APPS_PENDING_RESTART')}
        </Tooltip>
        <div className="pendingRestart absolute top-0 right-0 rounded-tr-lg rounded-bl-lg bg-warning text-warning-foreground p-1.5">
          <RotateCw size={20} />
        </div>
      </>
    );
  } else if (updateAvailable) {
    badge = (
      <>
        <Tooltip className="tooltip" anchorSelect=".updateAvailable">
          {t('COMMON_UPDATE_AVAILABLE')}
        </Tooltip>
        <div className="updateAvailable absolute top-0 right-0 rounded-tr-lg rounded-bl-lg bg-success text-success-foreground p-1.5">
          <Download size={20} />
        </div>
      </>
    );
  } else if (status === 'install_failed') {
    const [slug] = info.urn.split(':');
    if (slug) {
      badge = (
        <div className="absolute top-0 right-0 rounded-tr-lg rounded-bl-lg bg-destructive text-destructive-foreground p-1.5">
          <InstallRetryButton
            urn={info.urn}
            name={info.name}
            slug={slug}
            config={installConfig}
            size="md"
            className="relative inset-auto flex items-center justify-center bg-transparent hover:bg-transparent"
          />
        </div>
      );
    }
  } else if (info.deprecated) {
    badge = (
      <>
        <Tooltip className="tooltip" anchorSelect=".deprecated">
          {t('COMMON_THIS_APP_IS_DEPRECATED')}
        </Tooltip>
        <div className="deprecated absolute top-0 right-0 rounded-tr-lg rounded-bl-lg bg-red-500 text-white p-1.5">
          <AlertCircle />
        </div>
      </>
    );
  }

  return (
    <Card className="relative hover:bg-accent/50 transition-colors">
      <CardContent className="flex items-center gap-3 p-4">
        <AppLogo alt={`${info.name} logo`} urn={info.urn} size={60} className={available ? undefined : 'opacity-50 grayscale'} />
        <div className="flex flex-col justify-center">
          <div className="flex items-center gap-2">
            <span className="font-bold">{info.name}</span>
            <AppStatus lite status={status} />
          </div>
          <div className="text-muted-foreground text-sm">{limitText(info.short_desc, 50)}</div>
        </div>
      </CardContent>
      {badge}
    </Card>
  );
};
