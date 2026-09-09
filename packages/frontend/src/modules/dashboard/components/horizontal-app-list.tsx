import { SimpleAppTile } from './simple-app-tile';
import { Link } from 'react-router';
import { useEffect, useMemo, useState } from 'react';
import type { AppInfo, AppStatus } from '@/types/app.types';
import { CATALOG_PAGE_SIZE } from '@/lib/catalog-page-size';
import { useTranslation } from 'react-i18next';

interface InstalledApp {
  info: Pick<AppInfo, 'urn' | 'name'>;
  app: { id: number; status: AppStatus; config?: Record<string, unknown> };
}

interface HorizontalAppListProps {
  apps: InstalledApp[];
  isLoading?: boolean;
}

const SKELETON_KEYS = Array.from({ length: CATALOG_PAGE_SIZE }, (_, i) => `installed-skeleton-${i}`);

const APP_GRID_STYLE = {
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
  overflowX: 'auto',
  scrollBehavior: 'smooth',
  scrollbarWidth: 'none',
  alignContent: 'start',
} as const;

export const HorizontalAppList = ({ apps, isLoading = false }: HorizontalAppListProps) => {
  const { t } = useTranslation();

  // A urn identifies an installed app exactly once, so it — not `app.id` — is the tile's identity.
  // Optimistic rows carry a synthetic id, and the DB has no unique index on (app_name, app_store_slug),
  // so ids are the less trustworthy key of the two. Duplicate React keys are not a cosmetic problem:
  // React keeps one fiber per key, so a collision leaves the surplus fibers undeleted and their DOM
  // nodes stranded on screen — which is how N apps rendered as 2N-1 tiles after onboarding.
  const visibleApps = useMemo(() => {
    const seen = new Set<string>();

    return apps.filter(({ info }) => {
      if (!info.urn || seen.has(info.urn)) return false;
      seen.add(info.urn);
      return true;
    });
  }, [apps]);

  const [paintedCount, setPaintedCount] = useState(Math.min(visibleApps.length, CATALOG_PAGE_SIZE));

  useEffect(() => {
    setPaintedCount(Math.min(visibleApps.length, CATALOG_PAGE_SIZE));
    if (visibleApps.length <= CATALOG_PAGE_SIZE) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      setPaintedCount(visibleApps.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [visibleApps]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <div className="grid gap-3 py-2 px-1" style={APP_GRID_STYLE}>
          {SKELETON_KEYS.map((key) => (
            <div key={key} data-testid="app-tile-skeleton" className="h-14 animate-pulse rounded-md bg-muted/40" />
          ))}
        </div>
      </div>
    );
  }

  if (visibleApps.length === 0) {
    return (
      <Link to="/store" className="flex justify-center items-center no-underline py-16 sm:py-0 w-full" style={{ minHeight: 0 }}>
        <h1 className="text-center text-xl sm:text-3xl text-muted-foreground/30 font-medium px-4">
          {t('DASHBOARD_NO_APPS_MESSAGE', 'Click here to install your first app')}
        </h1>
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-3 py-2 px-1" style={APP_GRID_STYLE}>
        {visibleApps.slice(0, paintedCount).map(({ info, app }) => {
          const [appName, storeId] = info.urn.split(':');
          return (
            <Link key={info.urn} to={`/apps/${storeId}/${appName}`} className="no-underline text-inherit">
              <SimpleAppTile
                name={info.name}
                urn={info.urn}
                status={app.status}
                isInstalling={app.status === 'installing'}
                installConfig={app.config}
              />
            </Link>
          );
        })}
      </div>
    </div>
  );
};
