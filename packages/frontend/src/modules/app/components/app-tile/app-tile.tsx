import { AppLogo } from '@/components/app-logo/app-logo';
import { Card, CardContent } from '@/components/ui/Card';
import { limitText } from '@/lib/helpers/text-helpers';
import type { AppInfo, AppStatus as AppStatusType } from '@/types/app.types';
import { AlertCircle, Download, RotateCw } from 'lucide-react';
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
}> = ({ info, status, updateAvailable, pendingRestart }) => {
  const { t } = useTranslation();

  let badge = null;

  // Using if-else sets the badge once while rendering them in the return causes badges to stack
  if (pendingRestart) {
    badge = (
      <>
        <Tooltip className="tooltip" anchorSelect=".pendingRestart">
          {t('MY_APPS_PENDING_RESTART')}
        </Tooltip>
        <div className="pendingRestart absolute top-0 right-0 rounded-tr-lg rounded-bl-lg bg-amber-500 text-white p-1.5">
          <RotateCw size={20} />
        </div>
      </>
    );
  } else if (updateAvailable) {
    badge = (
      <>
        <Tooltip className="tooltip" anchorSelect=".updateAvailable">
          {t('MY_APPS_UPDATE_AVAILABLE')}
        </Tooltip>
        <div className="updateAvailable absolute top-0 right-0 rounded-tr-lg rounded-bl-lg bg-green-500 text-white p-1.5">
          <Download size={20} />
        </div>
      </>
    );
  } else if (info.deprecated) {
    badge = (
      <>
        <Tooltip className="tooltip" anchorSelect=".deprecated">
          {t('MY_APPS_DEPRECATED')}
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
        <AppLogo alt={`${info.name} logo`} urn={info.urn} size={60} />
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
