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
import { guestTileAddresses } from './guest-tile-addresses';

const SKELETON_KEYS = Array.from({ length: CATALOG_PAGE_SIZE }, (_, i) => `guest-skeleton-${i}`);

const Tile = ({ data, sslPort, publicDomain }: { data: GuestAppsDto['installed'][number]; sslPort: number; publicDomain: string }) => {
  const { info, app } = data;
  const addresses = guestTileAddresses({ data, sslPort, publicDomain, viewerHostname: window.location.hostname });
  const tile = <AppTile key={info.urn} info={info} status={app.status} updateAvailable={false} />;

  if (addresses.length === 0) {
    return tile;
  }

  return (
    <DropdownMenu modal={false}>
      {/* A bare <div> cannot be reached with the keyboard, so a guest without a mouse could not open a tile.
          Radix supplies Enter, Space and the arrow keys to whatever it is given as the trigger. */}
      <DropdownMenuTrigger asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: the tile can hold the install-retry <button>, and a button may not contain one */}
        <div
          role="button"
          tabIndex={0}
          className="relative group cursor-pointer rounded-lg transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-300 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
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

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <Header isLoggedIn={false} />
      <div className="flex flex-1 flex-col pt-24 px-4 container mx-auto pb-[max(2rem,var(--safe-area-bottom))]">
        {loadFailed && (
          <div className="flex flex-col items-start gap-2 py-8">
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
        )}
        {!hasContent && !loading && !loadFailed && <EmptyPage title="GUEST_DASHBOARD_NO_APPS" subtitle="GUEST_DASHBOARD_NO_APPS_SUBTITLE" />}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {appsPending &&
            !appsError &&
            SKELETON_KEYS.map((key) => <div key={key} data-testid="app-tile-skeleton" className="h-24 animate-pulse rounded-lg bg-muted/40" />)}
          {installed.slice(0, paintedCount).map((appData) => {
            return <Tile key={appData.app.id} data={appData} sslPort={sslPort} publicDomain={domain} />;
          })}
          {linksData?.links.map((link) => (
            <GuestLinkTile key={link.id} link={link} />
          ))}
        </div>
      </div>
    </div>
  );
};
