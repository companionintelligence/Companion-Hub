import type { GuestAppsDto } from '@/api-client';
import { getGuestAppsOptions, getGuestLinksOptions } from '@/api-client/@tanstack/react-query.gen';
import { Header } from '@/components/header/header';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { AppTile } from '@/modules/app/components/app-tile/app-tile';
import { Lock, LockOpen } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import '@/styles/app-grid.css';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { useUserContext } from '@/context/user-context';
import { GuestLinkTile } from '../components/guest-link-tile';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { openExternal } from '@/lib/helpers/open-external';

const LOCAL_BROWSER_HOST = '127.0.0.1';

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
      <DropdownMenuTrigger asChild>
        <div className="relative group cursor-pointer rounded-lg transition-all duration-300 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
          <AppTile key={info.urn} info={info} status={app.status} updateAvailable={false} />
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          {app.exposed && app.domain && (
            <DropdownMenuItem onClick={() => handleOpen('domain')}>
              <Lock className="text-green-500 mr-2" size={16} />
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
  const { sslPort } = useUserContext();

  const { data: appsData, isLoading: appsLoading } = useQuery({
    ...getGuestAppsOptions(),
    staleTime: 30_000,
  });

  const { data: linksData, isLoading: linksLoading } = useQuery({
    ...getGuestLinksOptions(),
    staleTime: 30_000,
  });

  const hasContent = (appsData?.installed?.length ?? 0) > 0 || (linksData?.links?.length ?? 0) > 0;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header isLoggedIn={false} />
      <div className="flex flex-1 flex-col pt-24 px-4 container mx-auto pb-8">
        {!hasContent && !appsLoading && !linksLoading && <EmptyPage title="GUEST_DASHBOARD_NO_APPS" subtitle="GUEST_DASHBOARD_NO_APPS_SUBTITLE" />}
        {(appsLoading || linksLoading) && <LoadingSpinner />}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {appsData?.installed.map((appData) => {
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
