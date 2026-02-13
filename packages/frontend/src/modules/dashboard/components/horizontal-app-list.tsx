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
      <Link to="/app-store" className="flex justify-center items-center no-underline" style={{ minHeight: '380px', width: '100%' }}>
        <h1 className="text-center text-3xl text-muted-foreground/30 font-medium">
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
          gridTemplateRows: 'repeat(3, min-content)',
          gridAutoFlow: 'column',
          gridAutoColumns: 'max-content',
          overflowX: 'auto',
          scrollBehavior: 'smooth',
          scrollbarWidth: 'none',
          minHeight: '380px',
          alignContent: 'start',
        }}
      >
        {apps.map(({ info, app }) => {
          const [appName, storeId] = info.urn.split(':');
          return (
            <Link key={app.id} to={`/apps/${storeId}/${appName}`} className="no-underline text-inherit">
              <SimpleAppTile name={info.name} urn={info.urn} />
            </Link>
          );
        })}
      </div>
    </div>
  );
};
