import type { GuestAppsDto } from '@/api-client';
import { getGuestAppsOptions, getGuestLinksOptions } from '@/api-client/@tanstack/react-query.gen';
import { Header } from '@/components/header/header';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { CATALOG_PAGE_SIZE } from '@/lib/catalog-page-size';
import { AppTile } from '@/modules/app/components/app-tile/app-tile';
import { Lock, LockOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import '@/styles/app-grid.css';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { useUserContext } from '@/context/user-context';
import { GuestLinkTile } from '../components/guest-link-tile';
import { openExternal } from '@/lib/helpers/open-external';

const LOCAL_BROWSER_HOST = '127.0.0.1';
const SKELETON_KEYS = Array.from({ length: CATALOG_PAGE_SIZE }, (_, i) => `guest-skeleton-${i}`);

const Tile = ({ data, sslPort }: { data: GuestAppsDto['installed'][number]; sslPort: number }) => {
  const { info, app } = data;

  const directPort = app.port ?? info.port ?? null;

  const handleOpen = (type: string) => {
    let url = '';
    const urlSuffix = info.url_suffix || '';

    if (type === 'domain' && app.domain) {
      url = `https://${app.domain}${sslPort === 443 ? '' : `:${sslPort}`}${urlSuffix}`;
    }

    if (type === 'local' && directPort) {
      url = `http://${LOCAL_BROWSER_HOST}:${directPort}${urlSuffix}`;
    }

    openExternal(url);
  };

  return (
    <DropdownMenu modal={false}>
      {/* A bare <div> cannot be reached with the keyboard, so a guest without a mouse could not open a tile.
          Radix supplies Enter, Space and the arrow keys to whatever it is given as the trigger. */}
      <DropdownMenuTrigger asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: the tile can hold the install-retry <button>, and a button may not contain one */}
        <div
          role="button"
          tabIndex={0}
          className="relative group cursor-pointer rounded-lg transition-all duration-300 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          <AppTile key={info.urn} info={info} status={app.status} updateAvailable={false} />
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          {app.exposed && app.domain && (
            <DropdownMenuItem onClick={() => handleOpen('domain')}>
              <Lock className="text-success mr-2" size={16} />
              {app.domain}
              {sslPort === 443 ? '' : `:${sslPort}`}
            </DropdownMenuItem>
          )}
          {(app.exposedLocal || app.openPort || !info.dynamic_config) && directPort && (
            <DropdownMenuItem onClick={() => handleOpen('local')}>
              <LockOpen className="text-muted-foreground mr-2" size={16} />
              {LOCAL_BROWSER_HOST}:{directPort}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const GuestDashboard = () => {
  const { t } = useTranslation();
  const { sslPort } = useUserContext();

  const {
    data: appsData,
    isPending: appsPending,
    isError: appsError,
    refetch: refetchApps,
  } = useQuery({
    ...getGuestAppsOptions(),
    staleTime: 30_000,
  });

  const {
    data: linksData,
    isPending: linksPending,
    isError: linksError,
    refetch: refetchLinks,
  } = useQuery({
    ...getGuestLinksOptions(),
    staleTime: 30_000,
  });

  const installed = appsData?.installed ?? [];
  const [paintedCount, setPaintedCount] = useState(0);

  useEffect(() => {
    const list = appsData?.installed;
    if (appsPending || !list) {
      setPaintedCount(0);
      return;
    }

    setPaintedCount(Math.min(list.length, CATALOG_PAGE_SIZE));
    if (list.length <= CATALOG_PAGE_SIZE) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      setPaintedCount(list.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [appsPending, appsData?.installed]);

  const hasContent = installed.length > 0 || (linksData?.links?.length ?? 0) > 0;
  const loading = appsPending || linksPending;
  const loadFailed = (appsError || linksError) && !hasContent;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header isLoggedIn={false} />
      <div className="flex flex-1 flex-col pt-24 px-4 container mx-auto pb-[max(2rem,var(--safe-area-bottom))]">
        {loadFailed && (
          <div className="flex flex-col items-start gap-2 py-8">
            <p className="text-sm text-muted-foreground">{t('GUEST_DASHBOARD_LOAD_FAILED')}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void refetchApps();
                void refetchLinks();
              }}
            >
              {t('COMMON_RETRY')}
            </Button>
          </div>
        )}
        {!hasContent && !loading && !loadFailed && <EmptyPage title="GUEST_DASHBOARD_NO_APPS" subtitle="GUEST_DASHBOARD_NO_APPS_SUBTITLE" />}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {appsPending &&
            !appsError &&
            SKELETON_KEYS.map((key) => <div key={key} data-testid="app-tile-skeleton" className="h-24 animate-pulse rounded-lg bg-muted/40" />)}
          {installed.slice(0, paintedCount).map((appData) => {
            return <Tile key={appData.app.id} data={appData} sslPort={sslPort} />;
          })}
          {linksData?.links.map((link) => (
            <GuestLinkTile key={link.id} link={link} />
          ))}
        </div>
      </div>
    </div>
  );
};
