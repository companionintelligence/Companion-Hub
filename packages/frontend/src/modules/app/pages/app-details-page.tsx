import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { client } from '@/api-client/client.gen';
import { Card, CardContent } from '@/components/ui/Card/Card';
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
import { HardDrive, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCategoryLabel } from '../helpers/category-label';
import { AppRuntimeDegradedBanner } from '../components/app-runtime-degraded-banner';
import { AppAccessPoints } from '../components/app-access-points/app-access-points';

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
  const runtimeHealthEnabled = Boolean(getApp.data?.app && getApp.data.app.status !== 'uninstalling');

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
    enabled: runtimeHealthEnabled,
  });

  const { userSettings } = useAppContext();

  if (getApp.isLoading || !getApp.data) {
    return <PageLoadingSpinner />;
  }

  const { info, app, metadata } = getApp.data;
  const logoUrn = info?.urn ?? appUrn;
  const logoUrl = getMarketplaceAppImageUrl(logoUrn);
  const primaryCategory = info?.categories?.[0];
  const headerStats = [
    {
      key: 'rating',
      value: (
        <span className="flex items-center gap-1">
          <span>0.0</span>
          <Star className="h-3.5 w-3.5 fill-yellow-500 text-yellow-500" />
        </span>
      ),
      label: t('APP_DETAILS_ZERO_RATINGS'),
    },
    {
      key: 'price',
      value: <span className="text-emerald-500">{t('APP_PRICE_FREE')}</span>,
      label: t('APP_DETAILS_PRICE_LABEL'),
    },
    ...(primaryCategory
      ? [
          {
            key: 'category',
            value: <span>{getCategoryLabel(t, primaryCategory)}</span>,
            label: t('APP_DETAILS_CATEGORIES_TITLE'),
          },
        ]
      : []),
    {
      key: 'size',
      value: (
        <span className="flex items-center gap-1">
          <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
          <span>
            {imageSize.isLoading ? t('APP_DETAILS_CALCULATING') : imageSize.data?.formatted ? `~${imageSize.data.formatted}` : t('COMMON_UNKNOWN')}
          </span>
        </span>
      ),
      label: t('APP_DETAILS_DOWNLOAD_SIZE'),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-20 sm:space-y-8">
      <AppRuntimeDegradedBanner runtimeHealth={runtimeHealth.data} />
      <Card className="overflow-hidden border-border/60 bg-card/80 shadow-sm">
        <CardContent className="p-5 sm:p-6">
          <div className="grid gap-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-start">
            <div className="flex justify-center lg:justify-start">
              <img
                src={logoUrl}
                alt={info?.name}
                className="h-24 w-24 rounded-3xl object-cover bg-white/10 shadow-xl sm:h-28 sm:w-28 md:h-32 md:w-32"
                onError={(e) => {
                  e.currentTarget.src = '/app-not-found.jpg';
                }}
              />
            </div>

            <div className="min-w-0 space-y-4">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl md:text-4xl">{info?.name}</h1>
                  {primaryCategory && (
                    <span className="rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                      {getCategoryLabel(t, primaryCategory)}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground sm:text-base">{info?.author}</p>
                {info.short_desc && <p className="max-w-3xl text-sm leading-6 text-foreground/85 sm:text-base">{info.short_desc}</p>}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {headerStats.map((stat) => (
                  <div key={stat.key} className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
                    <div className="text-sm font-semibold">{stat.value}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{stat.label}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex min-w-0 flex-col items-stretch gap-3 lg:min-w-[220px] lg:items-end">
              <div className="flex w-full flex-wrap gap-3 lg:justify-end">
                <AppActions
                  app={app}
                  metadata={metadata}
                  info={info}
                  localDomain={userSettings.localDomain}
                  sslPort={userSettings.sslPort}
                  runtimeHealth={runtimeHealth.data}
                />
              </div>
              {app?.status && app.status !== 'missing' && (
                <div className="rounded-full border border-border/70 bg-muted/20 px-3 py-1.5">
                  <AppStatus status={app.status} />
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <AppAccessPoints app={app} info={info} />

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
