import type { GuestAppsDto } from '@/api-client';
import { getGuestAppsOptions, getGuestLinksOptions } from '@/api-client/@tanstack/react-query.gen';
import { Header } from '@/components/header/header';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { CATALOG_PAGE_SIZE } from '@/lib/catalog-page-size';
import { isLocalAppDefaultShortDesc } from '@ci-hub/common/types';
import { Lock, LockOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { useUserContext } from '@/context/user-context';
import { GuestLinkTile } from '../components/guest-link-tile';
import { APP_GRID_STYLE } from '../components/horizontal-app-list';
import { SimpleAppTile } from '../components/simple-app-tile';
import { openExternal } from '@/lib/helpers/open-external';
import { guestTileAddresses } from './guest-tile-addresses';

const SKELETON_KEYS = Array.from({ length: CATALOG_PAGE_SIZE }, (_, i) => `guest-skeleton-${i}`);

const Tile = ({ data, sslPort, publicDomain }: { data: GuestAppsDto['installed'][number]; sslPort: number; publicDomain: string }) => {
  const { info, app } = data;
  const addresses = guestTileAddresses({ data, sslPort, publicDomain, viewerHostname: window.location.hostname });
  // Home's tile. The description the Hub writes for a custom app ("User-created custom app") says nothing to a guest.
  const description = info.short_desc && !isLocalAppDefaultShortDesc(info.short_desc) ? info.short_desc : undefined;
  // A guest can't retry a failed install, so the tile doesn't offer it.
  const status = app.status === 'install_failed' ? undefined : app.status;
  const tile = <SimpleAppTile key={info.urn} name={info.name} urn={info.urn} status={status} description={description} />;

  if (addresses.length === 0) {
    return tile;
  }

  return (
    <DropdownMenu modal={false}>
      {/* A bare <div> cannot be reached with the keyboard, so a guest without a mouse could not open a tile.
          Radix supplies Enter, Space and the arrow keys to whatever it is given as the trigger. */}
      <DropdownMenuTrigger asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: Home's tile is block content, which a <button> may not hold */}
        <div role="button" tabIndex={0} className="cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {tile}
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          {addresses.map((address) => (
            <DropdownMenuItem key={address.key} onClick={() => openExternal(address.url)}>
              {address.key === 'local' ? (
                <LockOpen className="text-muted-foreground mr-2" size={16} />
              ) : (
                <Lock className="text-success mr-2" size={16} />
              )}
              {address.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const GuestDashboard = () => {
  const { t } = useTranslation();
  const { sslPort, domain, refreshUserContext } = useUserContext();

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

  const links = linksData?.links ?? [];

  // Laid out like Home: a title, then the apps in Home's card and grid, with the links as the same tiles
  // after them. Loading, empty and failed take Home's forms too.
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <Header isLoggedIn={false} />
      <main className="container mx-auto flex flex-1 flex-col gap-4 px-4 pt-24 pb-[max(2rem,var(--safe-area-bottom))]">
        <div className="space-y-1 px-1">
          <h1 className="text-2xl font-medium tracking-tight">{t('GUEST_DASHBOARD_TITLE')}</h1>
          <p className="text-sm text-muted-foreground">{t('GUEST_DASHBOARD_SUBTITLE')}</p>
        </div>
        {!hasContent && !loading && !loadFailed ? (
          <EmptyPage title="GUEST_DASHBOARD_NO_APPS" subtitle="GUEST_DASHBOARD_NO_APPS_SUBTITLE" />
        ) : (
          <section data-testid="guest-dashboard-apps" className="rounded-lg border border-border bg-card p-4 shadow-sm">
            {loadFailed ? (
              <div className="flex flex-col items-start gap-2 py-6">
                <p className="text-sm text-muted-foreground">{t('GUEST_DASHBOARD_LOAD_FAILED')}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    // This tab may still think the dashboard is on while both lists answer 403.
                    // A fresh user context sends the visitor to sign-in, which refetching the lists never would.
                    void refreshUserContext();
                    void refetchApps();
                    void refetchLinks();
                  }}
                >
                  {t('COMMON_RETRY')}
                </Button>
              </div>
            ) : loading ? (
              // Both lists at once: the links used to appear under a grid of app skeletons, then jump down.
              <div className="grid gap-3 py-2 px-1" style={APP_GRID_STYLE}>
                {SKELETON_KEYS.map((key) => (
                  <div key={key} data-testid="app-tile-skeleton" className="h-14 animate-pulse rounded-md bg-muted/40" />
                ))}
              </div>
            ) : (
              <div className="grid gap-3 py-2 px-1" style={APP_GRID_STYLE}>
                {installed.slice(0, paintedCount).map((appData) => (
                  <Tile key={appData.app.id} data={appData} sslPort={sslPort} publicDomain={domain} />
                ))}
                {links.map((link) => (
                  <GuestLinkTile key={link.id} link={link} />
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
};
