import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { client } from '@/api-client/client.gen';
import { useAppContext } from '@/context/app-context';
import { useQuery } from '@tanstack/react-query';
import { redirect, useParams } from 'react-router';
import { AppStatus } from '../components/app-status/app-status';
import { AppActions } from '../containers/app-actions/app-actions';
import { AppDetailsTabs } from '../containers/app-details-tabs/app-details-tabs';
import type { Route } from './+types/app-details-page';
import { GlassContainer } from '@/components/ui/glass-container';
import { PageLoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const { storeId } = params;

  if (storeId === '_user') {
    return redirect(`/apps/${params.appId}`);
  }
}

export default () => {
  const { appId, storeId } = useParams<{ appId: string; storeId: string }>();
  const appUrn = `${appId}:${storeId}`;

  const getApp = useQuery({
    ...getAppOptions({ path: { urn: appUrn } }),
    staleTime: 30_000,
  });

  const imageSize = useQuery({
    queryKey: ['app-image-size', appUrn],
    queryFn: async () => {
      const { data } = await client.get({ url: `/api/marketplace/apps/${appUrn}/image-size` });
      return data as { totalBytes: number | null; formatted: string | null };
    },
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: false,
  });

  const { userSettings } = useAppContext();

  if (getApp.isLoading || !getApp.data) {
    return <PageLoadingSpinner />;
  }

  const { info, app, metadata } = getApp.data;
  const logoUrl = info?.urn ? `/api/marketplace/apps/${info.urn}/image` : '/app-not-found.jpg';

  return (
    <div className="h-full overflow-y-auto w-full">
      <div className="max-w-5xl mx-auto space-y-5 sm:space-y-8 pb-20 px-4 pt-4 sm:p-6 md:p-10">
        {/* Header Section */}
        <div className="flex flex-row gap-4 sm:gap-8 items-start">
          {/* Logo */}
          <div className="flex-shrink-0">
            <img
              src={logoUrl}
              alt={info?.name}
              className="w-20 h-20 sm:w-32 sm:h-32 md:w-48 md:h-48 rounded-2xl sm:rounded-3xl shadow-2xl object-cover bg-white/10"
              onError={(e) => {
                e.currentTarget.src = '/app-not-found.jpg';
              }}
            />
          </div>

          <div className="flex-1 space-y-2 sm:space-y-4 min-w-0">
            <div>
              <h1 className="text-2xl sm:text-4xl font-bold mb-1 sm:mb-2 tracking-tight">{info?.name}</h1>
              <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                <span className="text-xs sm:text-sm font-medium px-2 py-0.5 sm:py-1 rounded-md bg-white/10 text-white/80">v{info?.version}</span>
                <div className="transform scale-90 origin-left">
                  <AppStatus status={app?.status ?? 'missing'} />
                </div>
              </div>
            </div>

            <p className="text-sm sm:text-lg text-muted-foreground leading-relaxed max-w-2xl">{info?.short_desc}</p>

            {/* Actions */}
            <div className="pt-1 sm:pt-2 flex flex-wrap gap-3">
              <AppActions app={app} metadata={metadata} info={info} localDomain={userSettings.localDomain} sslPort={userSettings.sslPort} />
            </div>
          </div>
        </div>

        {/* Main Content / Tabs */}
        <GlassContainer className="p-1 md:p-2 min-h-[300px] sm:min-h-[500px]">
          <AppDetailsTabs info={info} app={app} metadata={metadata} imageSizeFormatted={imageSize.data?.formatted ?? null} imageSizeLoading={imageSize.isLoading} />
        </GlassContainer>
      </div>
    </div>
  );
};
