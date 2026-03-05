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

const Tile = ({ data, localDomain, sslPort }: { data: GuestAppsDto['installed'][number]; localDomain: string; sslPort: number }) => {
  const { info, app } = data;

  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';

  const handleOpen = (type: string) => {
    let url = '';
    const { https } = info;
    const protocol = https ? 'https' : 'http';

    if (typeof window !== 'undefined') {
      // Current domain
      const domain = window.location.hostname;
      url = `${protocol}://${domain}:${app.port ?? info.port}${info.url_suffix || ''}`;
    }

    if (type === 'domain' && app.domain) {
      url = `https://${app.domain}${sslPort !== 443 ? `:${sslPort}` : ''}${info.url_suffix || ''}`;
    }

    if (type === 'localDomain') {
      url = `https://${app.localSubdomain}.${localDomain}${sslPort !== 443 ? `:${sslPort}` : ''}${info.url_suffix || ''}`;
    }

    window.open(url, '_blank', 'noreferrer');
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <div className="relative group cursor-pointer rounded-xl transition-all duration-300 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
          <AppTile key={info.urn} info={info} status={app.status} updateAvailable={false} />
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          {app.exposed && app.domain && (
            <DropdownMenuItem onClick={() => handleOpen('domain')}>
              <Lock className="text-green-500 mr-2" size={16} />
              {app.domain}
              {sslPort !== 443 ? `:${sslPort}` : ''}
            </DropdownMenuItem>
          )}
          {(app.exposedLocal || !info.dynamic_config) && (
            <DropdownMenuItem onClick={() => handleOpen('localDomain')}>
              <Lock className="text-muted-foreground mr-2" size={16} />
              {app.localSubdomain}.{localDomain}
              {sslPort !== 443 ? `:${sslPort}` : ''}
            </DropdownMenuItem>
          )}
          {(app.openPort || !info.dynamic_config) && (
            <DropdownMenuItem onClick={() => handleOpen('port')}>
              <LockOpen className="text-muted-foreground mr-2" size={16} />
              {hostname}:{app.port ?? info.port}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const GuestDashboard = () => {
  const { localDomain, sslPort } = useUserContext();

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
            return <Tile key={appData.app.id} data={appData} localDomain={localDomain} sslPort={sslPort} />;
          })}
          {linksData?.links.map((link) => (
            <GuestLinkTile key={link.id} link={link} />
          ))}
        </div>
      </div>
    </div>
  );
};
