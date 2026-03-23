import { SimpleAppTile } from './simple-app-tile';
import { Link } from 'react-router';
import type { AppInfo, AppStatus } from '@/types/app.types';
import { useTranslation } from 'react-i18next';

interface InstalledApp {
  info: Pick<AppInfo, 'urn' | 'name'>;
  app: { id: number; status: AppStatus };
}

interface HorizontalAppListProps {
  apps: InstalledApp[];
}

export const HorizontalAppList = ({ apps }: HorizontalAppListProps) => {
  const { t } = useTranslation();

  if (apps.length === 0) {
    return (
      <Link to="/app-store" className="flex justify-center items-center no-underline py-16 sm:py-0 w-full" style={{ minHeight: 0 }}>
        <h1 className="text-center text-xl sm:text-3xl text-muted-foreground/30 font-medium px-4">
          {t('DASHBOARD_NO_APPS_MESSAGE', 'Click here to install your first app')}
        </h1>
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className="grid gap-3 py-2 px-1"
        style={{
          gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
          overflowX: 'auto',
          scrollBehavior: 'smooth',
          scrollbarWidth: 'none',
          alignContent: 'start',
        }}
      >
        {apps.map(({ info, app }) => {
          const [appName, storeId] = info.urn.split(':');
          return (
            <Link key={app.id} to={`/apps/${storeId}/${appName}`} className="no-underline text-inherit">
              <SimpleAppTile name={info.name} urn={info.urn} status={app.status} isInstalling={app.status === 'installing'} />
            </Link>
          );
        })}
      </div>
    </div>
  );
};
