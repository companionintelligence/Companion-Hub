import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { client } from '@/api-client/client.gen';
import { useAppContext } from '@/context/app-context';
import { useQuery } from '@tanstack/react-query';
import { redirect, useParams } from 'react-router';
import { AppStatus } from '../components/app-status/app-status';
import { AppActions } from '../containers/app-actions/app-actions';
import { AppDetailsTabs } from '../containers/app-details-tabs/app-details-tabs';
import type { Route } from './+types/app-details-page';
import { PageLoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { fetchAppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { getMarketplaceAppImageUrl } from '@/lib/marketplace-image-url';
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCategoryLabel } from '../helpers/category-label';
import { AppRuntimeDegradedBanner } from '../components/app-runtime-degraded-banner';

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const { storeId } = params;

  if (storeId === '_user') {
    return redirect(`/apps/${params.appId}`);
  }

  return null;
}

export default () => {
  const { appId, storeId } = useParams<{ appId: string; storeId: string }>();
  const appUrn = `${appId}:${storeId}`;
  const { t } = useTranslation();

  const getApp = useQuery({
    ...getAppOptions({ path: { urn: appUrn } }),
    staleTime: 30_000,
  });

  const imageSize = useQuery({
    queryKey: ['app-image-size', appUrn],
    queryFn: async () => {
      const { data } = await client.get({ url: `/api/marketplace/apps/${encodeURIComponent(appUrn)}/image-size` });
      return data as { totalBytes: number | null; formatted: string | null };
    },
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: false,
  });

  const runtimeHealth = useQuery({
    queryKey: ['app-runtime-health', appUrn],
    queryFn: () => fetchAppRuntimeHealth(appUrn),
    refetchInterval: 15_000,
    enabled: Boolean(getApp.data?.app),
  });

  const { userSettings } = useAppContext();

  if (getApp.isLoading || !getApp.data) {
    return <PageLoadingSpinner />;
  }

  const { info, app, metadata } = getApp.data;
  const logoUrn = info?.urn ?? appUrn;
  const logoUrl = getMarketplaceAppImageUrl(logoUrn);
  const primaryCategory = info?.categories?.[0];

  return (
    <div className="max-w-5xl mx-auto space-y-6 sm:space-y-8 pb-20">
      <AppRuntimeDegradedBanner runtimeHealth={runtimeHealth.data} />
      {/* Header Section - Portal style */}
      <div className="flex flex-row gap-5 sm:gap-8 items-start">
        {/* Logo */}
        <div className="flex-shrink-0">
          <img
            src={logoUrl}
            alt={info?.name}
            className="w-20 h-20 sm:w-28 sm:h-28 md:w-36 md:h-36 rounded-2xl sm:rounded-3xl shadow-2xl object-cover bg-white/10"
            onError={(e) => {
              e.currentTarget.src = '/app-not-found.jpg';
            }}
          />
        </div>

        <div className="flex-1 space-y-3 sm:space-y-4 min-w-0">
          {/* App name & author */}
          <div>
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight">{info?.name}</h1>
            <p className="text-sm sm:text-base text-muted-foreground mt-1">{info?.author}</p>
          </div>

          {/* Stats row: Ratings | Price | Category */}
          <div className="flex items-center gap-4 sm:gap-6 text-sm flex-wrap">
            <div className="flex flex-col items-center">
              <div className="flex items-center gap-1">
                <span className="font-semibold">0.0</span>
                <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500" />
              </div>
              <span className="text-xs text-muted-foreground">{t('APP_DETAILS_ZERO_RATINGS')}</span>
            </div>
            <div className="h-8 w-px bg-border" />
            <div className="flex flex-col items-center">
              <span className="font-semibold text-emerald-400">{t('APP_PRICE_FREE')}</span>
              <span className="text-xs text-muted-foreground">{t('APP_DETAILS_PRICE_LABEL')}</span>
            </div>
            {primaryCategory && (
              <>
                <div className="h-8 w-px bg-border" />
                <div className="flex flex-col items-center">
                  <span className="font-semibold">{getCategoryLabel(t, primaryCategory)}</span>
                  <span className="text-xs text-muted-foreground">{t('APP_DETAILS_CATEGORIES_TITLE')}</span>
                </div>
              </>
            )}
          </div>

          {/* Actions & Status */}
          <div className="flex items-center gap-3 flex-wrap">
            <AppActions
              app={app}
              metadata={metadata}
              info={info}
              localDomain={userSettings.localDomain}
              sslPort={userSettings.sslPort}
              runtimeHealth={runtimeHealth.data}
            />
            <div className="transform scale-90 origin-left">
              <AppStatus status={app?.status ?? 'missing'} />
            </div>
          </div>
        </div>
      </div>

      {/* Main Content - two-column portal layout */}
      <AppDetailsTabs
        info={info}
        app={app}
        metadata={metadata}
        imageSizeFormatted={imageSize.data?.formatted ?? null}
        imageSizeLoading={imageSize.isLoading}
      />
    </div>
  );
};
