import { useSearchParams } from 'react-router';
import { AppDetailsTabs } from '../containers/app-details-tabs/app-details-tabs';
import { AppActions } from '../containers/app-actions/app-actions';
import { AppStatus } from '../components/app-status/app-status';
import { CustomAppLogo } from '@/components/custom-app-logo/custom-app-logo';
import { Card, CardHeader } from '@/components/ui/Card';
import { useMutation, useQuery } from '@tanstack/react-query';
import { uploadAppImageMutation } from '@/api-client/@tanstack/react-query.gen';
import { useAppContext } from '@/context/app-context';
import { fetchAppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { getMarketplaceAppImageUrl } from '@/lib/marketplace-image-url';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { TranslatableError } from '@/types/error.types';
import { useState } from 'react';
import { AppRuntimeDegradedBanner } from '../components/app-runtime-degraded-banner';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';
import { useAppUrlAvailability } from '../helpers/use-app-url-availability';

interface Props {
  appId: string;
  info: AppInfo;
  app?: AppDetails | null;
  metadata: AppMetadata;
}

export const CustomAppDetailsPageContent = ({ appId, info, app, metadata }: Props) => {
  const { t } = useTranslation();
  const runtimeHealthEnabled = Boolean(app && app.status !== 'uninstalling');

  const { userSettings } = useAppContext();
  const [searchParams] = useSearchParams();
  const [bust, setBust] = useState(searchParams.get('bust'));

  const imageUrl = new URL(getMarketplaceAppImageUrl(`${appId}:_user`), window.location.origin);

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
    queryKey: ['app-runtime-health', `${appId}:_user`],
    queryFn: () => fetchAppRuntimeHealth(`${appId}:_user`),
    refetchInterval: 15_000,
    enabled: runtimeHealthEnabled,
  });

  // Single owner for public-route readiness, shared with both the status pill
  // and the launch action so they can't report contradictory states.
  const urlAvailability = useAppUrlAvailability({
    appUrn: `${appId}:_user`,
    status: app?.status,
    noGui: info?.no_gui,
    exposureMode: app?.exposureMode,
  });

  const handleImageUpload = (file: File) => {
    uploadImage.mutate({
      path: { urn: `${appId}:_user` },
      body: { image: file },
    });
  };

  if (bust) {
    imageUrl.searchParams.set('t', bust);
  }

  return (
    <div className="h-full overflow-y-auto">
      <AppRuntimeDegradedBanner runtimeHealth={runtimeHealth.data} />
      <Card data-testid="app-details">
        <CardHeader className="flex flex-col md:flex-row border-0">
          <CustomAppLogo
            url={imageUrl.toString()}
            size={130}
            alt={info?.name}
            onImageUpload={handleImageUpload}
            isUploading={uploadImage.isPending}
          />
          <div className="w-full flex flex-col md:ml-3 items-center md:items-start">
            <div>
              <span className="mt-1 me-1">{t('COMMON_VERSION')}: </span>
              <span className="badge bg-muted mt-2 text-white">{info?.version}</span>
            </div>
            <span className="mt-1 text-muted-foreground text-center md:text-start mb-2">{info?.short_desc}</span>
            <div data-testid="app-header-actions-row" className="flex w-full flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <AppStatus
                  status={app?.status ?? 'missing'}
                  runtimeHealth={runtimeHealth.data}
                  publicUrl={{ propagating: urlAvailability.state === 'propagating', detail: urlAvailability.statusMessage }}
                  variant="pill"
                />
              </div>
              <div className="min-w-0 md:flex-1">
                <AppActions
                  app={app}
                  metadata={metadata}
                  info={info}
                  localDomain={userSettings.localDomain}
                  sslPort={userSettings.sslPort}
                  runtimeHealth={runtimeHealth.data}
                  urlAvailability={urlAvailability}
                  layout="hero"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <AppDetailsTabs info={info} app={app} metadata={metadata} />
      </Card>
    </div>
  );
};
