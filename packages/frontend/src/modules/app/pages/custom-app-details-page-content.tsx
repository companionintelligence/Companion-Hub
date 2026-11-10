import type { GetAppDto } from '@/api-client';
import { useSearchParams } from 'react-router';
import { AppDetailsTabs } from '../containers/app-details-tabs/app-details-tabs';
import { AppActions } from '../containers/app-actions/app-actions';
import { AppStatus } from '../components/app-status/app-status';
import { CustomAppLogo } from '@/components/custom-app-logo/custom-app-logo';
import { Card, CardContent } from '@/components/ui/Card';
import { useMutation, useQuery } from '@tanstack/react-query';
import { uploadAppImageMutation } from '@/api-client/@tanstack/react-query.gen';
import { useAppContext } from '@/context/app-context';
import { fetchAppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { getMarketplaceAppImageUrl } from '@/lib/marketplace-image-url';
import { isLocalAppDefaultShortDesc } from '@ci-hub/common/types';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { TranslatableError } from '@/types/error.types';
import { useState } from 'react';
import { AppBackupsCard } from '../components/app-backups-card/app-backups-card';
import { AppAccessPoints } from '../components/app-access-points/app-access-points';
import { AppHeaderStat, versionLabel } from '../components/app-header-stat/app-header-stat';
import { AppRuntimeDegradedBanner } from '../components/app-runtime-degraded-banner';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';
import { useAppUrlAvailability } from '../helpers/use-app-url-availability';
import { useCustomAppAccess } from '../helpers/use-custom-app-access';

interface Props {
  appId: string;
  info: AppInfo;
  app?: AppDetails | null;
  metadata: AppMetadata;
  failure?: GetAppDto['failure'];
}

/** A date the way the app page's Information column shows one. */
const shortDate = (ms: number | undefined) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' }) : null;

/**
 * A custom app's page, laid out like a store app's page (`app-details-page.tsx`): a header card with the
 * app's own name, its status and actions, then its addresses, its backups and the notes. It used to be
 * one card with "Version: 1.0.0" where the name goes.
 */
export const CustomAppDetailsPageContent = ({ appId, info, app, metadata, failure }: Props) => {
  const { t } = useTranslation();
  // A member sees the app, its status and Open; its settings, backups and lifecycle are an owner's or admin's.
  const access = useCustomAppAccess();
  const runtimeHealthEnabled = Boolean(app && app.status !== 'uninstalling');
  const appUrn = `${appId}:_user`;

  const { userSettings } = useAppContext();
  const [searchParams] = useSearchParams();
  const [bust, setBust] = useState(searchParams.get('bust'));

  const imageUrl = new URL(getMarketplaceAppImageUrl(appUrn), window.location.origin);

  const uploadImage = useMutation({
    ...uploadAppImageMutation(),
    onSuccess: () => {
      setBust(Date.now().toString());
      fetch(imageUrl.toString(), { method: 'HEAD' });
      toast.success(t('CUSTOM_APP_UPLOAD_SUCCESS'));
    },
    onError: (error: TranslatableError) => {
      toast.error(t(error.message, error.intlParams));
    },
  });

  const runtimeHealth = useQuery({
    queryKey: ['app-runtime-health', appUrn],
    queryFn: () => fetchAppRuntimeHealth(appUrn),
    refetchInterval: 15_000,
    enabled: runtimeHealthEnabled,
  });

  // Single owner for public-route readiness, shared with both the status pill
  // and the launch action so they can't report contradictory states.
  const urlAvailability = useAppUrlAvailability({
    appUrn,
    status: app?.status,
    noGui: info?.no_gui,
    exposureMode: app?.exposureMode,
  });

  const handleImageUpload = (file: File) => {
    uploadImage.mutate({
      path: { urn: appUrn },
      body: { image: file },
    });
  };

  if (bust) {
    imageUrl.searchParams.set('t', bust);
  }

  const createdDate = shortDate(info?.created_at);
  // The Hub writes "User-created custom app" into every new app; the line under the name already says so.
  const shortDesc = info?.short_desc && !isLocalAppDefaultShortDesc(info.short_desc) ? info.short_desc : null;

  return (
    <div className="page-scroller-edge-0 relative h-full overflow-y-auto" data-page-scroller="custom-app">
      <div className="mx-auto max-w-6xl space-y-4 px-0 pb-20 sm:space-y-8">
        <AppRuntimeDegradedBanner runtimeHealth={runtimeHealth.data} />
        <Card data-testid="app-details" className="overflow-hidden border-border/60 bg-card/80 shadow-sm">
          <CardContent className="space-y-4 p-3 sm:space-y-6 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
              <div className="h-24 w-24 shrink-0 rounded-md shadow-lg sm:h-28 sm:w-28 md:h-32 md:w-32">
                <CustomAppLogo
                  url={imageUrl.toString()}
                  size="100%"
                  shape="rounded"
                  alt={info?.name}
                  name={info?.name}
                  onImageUpload={access.may('configure') ? handleImageUpload : undefined}
                  isUploading={uploadImage.isPending}
                />
              </div>
              <div className="min-w-0 flex-1 space-y-3 sm:space-y-4">
                <div className="min-w-0 space-y-2">
                  <h1 className="break-words text-2xl font-medium tracking-tight sm:text-4xl">{info?.name}</h1>
                  <p className="text-base font-medium text-emerald-800 dark:text-emerald-400 sm:text-lg">{t('CUSTOM_APP_KIND')}</p>
                </div>
                <div data-testid="app-header-stats" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {info?.version ? (
                    <span data-testid="app-version" title={t('COMMON_VERSION')} className="max-w-48 truncate text-xs">
                      {versionLabel(info.version)}
                    </span>
                  ) : null}
                  {createdDate ? <AppHeaderStat testId="app-created" value={createdDate} label={t('COMMON_CREATED')} /> : null}
                </div>
                {shortDesc ? <p className="max-w-4xl text-sm leading-6 text-foreground/85 sm:text-base">{shortDesc}</p> : null}
              </div>
            </div>

            <div data-testid="app-header-actions-row" className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <AppStatus
                status={app?.status ?? 'missing'}
                runtimeHealth={runtimeHealth.data}
                publicUrl={{ propagating: urlAvailability.state === 'propagating', detail: urlAvailability.statusMessage }}
                variant="pill"
              />
              <div className="min-w-0 md:flex-1">
                <AppActions
                  app={app}
                  metadata={metadata}
                  info={info}
                  failure={failure}
                  localDomain={userSettings.localDomain}
                  sslPort={userSettings.sslPort}
                  runtimeHealth={runtimeHealth.data}
                  urlAvailability={urlAvailability}
                  layout="hero"
                  allowedActions={access.actions}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <AppAccessPoints app={app} info={info} publicAddressRefusal={urlAvailability.publicAddressRefusal} />

        {app && access.may('backup') ? <AppBackupsCard appUrn={appUrn} appName={info?.name ?? appId} status={app.status} /> : null}

        <AppDetailsTabs info={info} app={app} metadata={metadata} canEditNotes={access.may('configure')} />
      </div>
    </div>
  );
};
