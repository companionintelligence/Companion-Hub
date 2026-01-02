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
      <Link
        to="/app-store"
        className="d-flex justify-content-center align-items-center text-decoration-none text-reset"
        style={{ minHeight: '380px', width: '100%' }}
      >
        <h1 className="text-center" style={{ opacity: 0.3, fontSize: '3rem' }}>
          {t('DASHBOARD_NO_APPS_MESSAGE', 'Click here to install your first app')}
        </h1>
      </Link>
    );
  }

  return (
    <div className="d-flex flex-column gap-2">
      <div
        className="d-grid gap-3 py-2 px-1"
        style={{
          gridTemplateRows: 'repeat(3, min-content)',
          gridAutoFlow: 'column',
          gridAutoColumns: 'max-content',
          overflowX: 'auto',
          scrollBehavior: 'smooth',
          scrollbarWidth: 'none',
          minHeight: '380px', // Approximate height for 3 rows
          alignContent: 'start',
        }}
      >
        {apps.map(({ info, app }) => {
          const [appName, storeId] = info.urn.split(':');
          return (
            <Link key={app.id} to={`/apps/${storeId}/${appName}`} className="text-decoration-none text-reset">
              <SimpleAppTile name={info.name} urn={info.urn} />
            </Link>
          );
        })}
      </div>
    </div>
  );
};
