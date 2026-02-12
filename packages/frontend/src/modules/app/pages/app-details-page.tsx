import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { useAppContext } from '@/context/app-context';
import { useSuspenseQuery } from '@tanstack/react-query';
import { redirect, useParams } from 'react-router';
import { AppStatus } from '../components/app-status/app-status';
import { AppActions } from '../containers/app-actions/app-actions';
import { AppDetailsTabs } from '../containers/app-details-tabs/app-details-tabs';
import type { Route } from './+types/app-details-page';
import { GlassContainer } from '@/components/ui/glass-container';

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const { storeId } = params;

  if (storeId === '_user') {
    return redirect(`/apps/${params.appId}`);
  }
}

export default () => {
  const { appId, storeId } = useParams<{ appId: string; storeId: string }>();

  const getApp = useSuspenseQuery({
    ...getAppOptions({ path: { urn: `${appId}:${storeId}` } }),
  });

  const { userSettings } = useAppContext();

  const { info, app, metadata } = getApp.data;
  const logoUrl = info?.urn ? `/api/marketplace/apps/${info.urn}/image` : '/app-not-found.jpg';

  return (
    <div className="h-full overflow-y-auto w-full">
      <div className="max-w-5xl mx-auto space-y-8 pb-20 p-6 md:p-10">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row gap-8 items-start">
          {/* Logo */}
          <div className="flex-shrink-0">
            <img
              src={logoUrl}
              alt={info?.name}
              className="w-32 h-32 md:w-48 md:h-48 rounded-3xl shadow-2xl object-cover bg-white/10"
              onError={(e) => {
                e.currentTarget.src = '/app-not-found.jpg';
              }}
            />
          </div>

          <div className="flex-1 space-y-4 w-full">
            <div>
              <h1 className="text-4xl font-bold mb-2 tracking-tight">{info?.name}</h1>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-medium px-2 py-1 rounded-md bg-white/10 text-white/80">v{info?.version}</span>
                <div className="transform scale-90 origin-left">
                  <AppStatus status={app?.status ?? 'missing'} />
                </div>
              </div>
            </div>

            <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl">{info?.short_desc}</p>

            {/* Actions */}
            <div className="pt-2 flex flex-wrap gap-3">
              <AppActions app={app} metadata={metadata} info={info} localDomain={userSettings.localDomain} sslPort={userSettings.sslPort} />
            </div>
          </div>
        </div>

        {/* Main Content / Tabs */}
        <GlassContainer className="p-1 md:p-2 min-h-[500px]">
          <AppDetailsTabs info={info} app={app} metadata={metadata} />
        </GlassContainer>
      </div>
    </div>
  );
};
