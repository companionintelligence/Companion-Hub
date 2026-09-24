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
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { fetchAppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { getMarketplaceAppImageUrl } from '@/lib/marketplace-image-url';
import { HardDrive, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCategoryLabel } from '../helpers/category-label';
import { AppMediaGallery } from '../components/app-media-gallery/app-media-gallery';
import { useAppMedia } from '../hooks/use-app-media';
import { AppAccessPoints } from '../components/app-access-points/app-access-points';
import { AppReadinessBadge, AppReadinessChecksCard } from '../components/app-readiness/app-readiness';
import { AppRuntimeDegradedBanner } from '../components/app-runtime-degraded-banner';
import { CustomDomainRestartBanner } from '../components/custom-domain-restart-banner';
import { fetchPublicWebDiagnostics } from '@/lib/cloudflare-api';
import { McpAccessCard } from '../components/mcp-access-card/mcp-access-card';
import { MemoryStatusBadge } from '../components/memory-status-badge/memory-status-badge';
import { useAppUrlAvailability } from '../helpers/use-app-url-availability';

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const { storeId } = params;

  if (storeId === '_user') {
    return redirect(`/apps/${params.appId}`);
  }

  return null;
}

const INFORMATION_ROWS = ['provider', 'categories', 'updated', 'version', 'source', 'size'];

// Laid out like the loaded page (hero card, then About and Information) so
// nothing jumps when the app arrives.
function AppDetailsSkeleton() {
  const { t } = useTranslation();

  return (
    <div
      className="mx-auto max-w-6xl space-y-4 px-0 pb-20 sm:space-y-8"
      role="status"
      aria-busy="true"
      aria-label={t('COMMON_LOADING')}
      data-testid="app-details-skeleton"
    >
      <Card className="overflow-hidden border-border/60 bg-card/80 shadow-sm">
        <CardContent className="space-y-4 p-3 sm:space-y-6 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
            <Skeleton className="h-24 w-24 shrink-0 rounded-md sm:h-28 sm:w-28 md:h-32 md:w-32" />
            <div className="min-w-0 flex-1 space-y-3 sm:space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <Skeleton className="h-8 w-44 max-w-full sm:h-10 sm:w-72" />
                  <Skeleton className="h-6 w-40 max-w-full" />
                </div>
                <Skeleton className="h-9 w-20 rounded-md" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-8 w-36 max-w-full rounded-full sm:h-9 sm:w-44" />
                <Skeleton className="h-8 w-32 max-w-full rounded-full sm:h-9 sm:w-48" />
                <Skeleton className="h-8 w-44 max-w-full rounded-full sm:h-9 sm:w-60" />
              </div>
              <Skeleton className="h-5 w-full max-w-md" />
            </div>
          </div>
          {/* The install button sits right from 1280px, as in app-actions.css. */}
          <div className="flex min-[1280px]:justify-end">
            <Skeleton className="h-12 w-full rounded-md sm:w-44" />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px] md:gap-8">
        <div className="space-y-3">
          <Skeleton className="mb-4 h-7 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-7 w-32" />
          {INFORMATION_ROWS.map((row) => (
            <div key={row} className="flex items-center justify-between gap-4">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
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

  /*
   * The app row's `pendingRestart` says a restart is owed; it cannot say that a
   * customer's domain is dark because of it. Only the Hub's report distinguishes
   * the two, and only the second is worth putting a banner on this page for.
   */
  const { data: publicWebDiagnostics } = useQuery({
    queryKey: ['public-web-diagnostics'],
    queryFn: fetchPublicWebDiagnostics,
    staleTime: 30_000,
    enabled: runtimeHealthEnabled,
  });

  // Owned here (like runtimeHealth) and handed to BOTH the status pill and the
  // launch action, so the two can never disagree about whether the app's public
  // address is serving yet. Read through optionals because this must run before
  // the loading/error early-returns below — hooks can't be conditional.
  const urlAvailability = useAppUrlAvailability({
    appUrn,
    status: getApp.data?.app?.status,
    noGui: getApp.data?.info?.no_gui,
    exposureMode: getApp.data?.app?.exposureMode,
  });

  const appMedia = useAppMedia(appUrn, getApp.isSuccess);

  const { userSettings } = useAppContext();

  if (getApp.isLoading) {
    return <AppDetailsSkeleton />;
  }

  if (getApp.isError || !getApp.data) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold">{t('APP_ERROR_APP_NOT_FOUND', { id: appUrn })}</h1>
        <p className="mt-2 text-muted-foreground">{t('APP_DETAILS_LOAD_FAILED')}</p>
      </div>
    );
  }

  const { info, app, metadata, appDataHostPath } = getApp.data;
  const logoUrn = info?.urn ?? appUrn;
  const logoUrl = metadata?.iconUrl ?? getMarketplaceAppImageUrl(logoUrn);
  const primaryCategory = info?.categories?.[0];
  const headerStats = [
    {
      key: 'rating',
      value: (
        <span className="flex items-center gap-1.5">
          <span className="text-sm font-semibold">0.0</span>
          <Star className="h-3.5 w-3.5 fill-yellow-500 text-yellow-500" />
        </span>
      ),
      label: t('APP_DETAILS_ZERO_RATINGS'),
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
    <div className="mx-auto max-w-6xl space-y-4 px-0 pb-20 sm:space-y-8">
      <AppRuntimeDegradedBanner runtimeHealth={runtimeHealth.data} />
      <CustomDomainRestartBanner
        apps={(publicWebDiagnostics?.apps ?? []).filter((entry) => entry.appUrn === info.urn)}
        namesByUrn={{ [info.urn]: info.name }}
      />
      <Card className="overflow-hidden border-border/60 bg-card/80 shadow-sm">
        <CardContent className="space-y-4 p-3 sm:space-y-6 sm:p-6">
          <div className="space-y-4 sm:space-y-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
              <div className="flex shrink-0 justify-start">
                <img
                  src={logoUrl}
                  alt={info?.name}
                  className="h-24 w-24 rounded-md object-cover bg-white/10 shadow-lg sm:h-28 sm:w-28 md:h-32 md:w-32"
                  onError={(e) => {
                    e.currentTarget.src = '/app-not-found.jpg';
                  }}
                />
              </div>

              <div className="min-w-0 flex-1 space-y-3 sm:space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-4xl">{info?.name}</h1>
                    {info?.author ? <p className="text-base font-medium text-emerald-800 dark:text-emerald-400 sm:text-lg">{info.author}</p> : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-emerald-950 shadow-sm">
                      {t('APP_PRICE_FREE')}
                    </span>
                    <MemoryStatusBadge appUrn={appUrn} />
                    <AppReadinessBadge readiness={runtimeHealth.data?.readiness} />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {headerStats.map((stat) => (
                    <div
                      key={stat.key}
                      className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/30 px-2.5 py-1 sm:px-3 sm:py-1.5"
                    >
                      <span className="text-foreground">{stat.value}</span>
                      <span className="text-xs text-muted-foreground">{stat.label}</span>
                    </div>
                  ))}
                </div>

                {info.short_desc && <p className="max-w-4xl text-sm leading-6 text-foreground/85 sm:text-base">{info.short_desc}</p>}
              </div>
            </div>

            <div data-testid="app-header-actions-row" className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              {app ? (
                <AppStatus
                  status={app.status}
                  runtimeHealth={runtimeHealth.data}
                  publicUrl={{ propagating: urlAvailability.state === 'propagating', detail: urlAvailability.statusMessage }}
                  variant="pill"
                />
              ) : null}
              <div className="min-w-0 md:flex-1">
                <AppActions
                  app={app}
                  metadata={metadata}
                  info={info}
                  appDataHostPath={appDataHostPath}
                  localDomain={userSettings.localDomain}
                  sslPort={userSettings.sslPort}
                  runtimeHealth={runtimeHealth.data}
                  urlAvailability={urlAvailability}
                  layout="hero"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <AppMediaGallery
        appName={info?.name ?? appUrn}
        screenshots={appMedia.data?.screenshots ?? []}
        demoVideoUrl={appMedia.data?.demoVideoUrl ?? null}
        isLoading={appMedia.isLoading}
      />

      <AppAccessPoints app={app} info={info} />

      <AppReadinessChecksCard readiness={runtimeHealth.data?.readiness} />

      <McpAccessCard app={app} info={info} mcpRuntime={getApp.data.mcpRuntime ?? null} />

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
