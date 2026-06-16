import { useParams, useSearchParams } from 'react-router';
import { AppDetailsTabs } from '../containers/app-details-tabs/app-details-tabs';
import { AppActions } from '../containers/app-actions/app-actions';
import { AppStatus } from '../components/app-status/app-status';
import { CustomAppLogo } from '@/components/custom-app-logo/custom-app-logo';
import { Card, CardHeader } from '@/components/ui/Card';
import { useMutation, useQuery } from '@tanstack/react-query';
import { getAppOptions, uploadAppImageMutation } from '@/api-client/@tanstack/react-query.gen';
import { useAppContext } from '@/context/app-context';
import { fetchAppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { getMarketplaceAppImageUrl } from '@/lib/marketplace-image-url';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { TranslatableError } from '@/types/error.types';
import { useState } from 'react';
import { PageLoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { AppRuntimeDegradedBanner } from '../components/app-runtime-degraded-banner';

export const CustomAppDetailsPage = () => {
  const params = useParams<{ appId: string }>();
  const { t } = useTranslation();

  const getApp = useQuery({
    ...getAppOptions({ path: { urn: `${params.appId}:_user` } }),
    staleTime: 30_000,
  });
  const runtimeHealthEnabled = Boolean(getApp.data?.app && getApp.data.app.status !== 'uninstalling');

  const { userSettings } = useAppContext();
  const [searchParams] = useSearchParams();
  const [bust, setBust] = useState(searchParams.get('bust'));

  const imageUrl = new URL(getMarketplaceAppImageUrl(`${params.appId}:_user`), window.location.origin);

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
    queryKey: ['app-runtime-health', `${params.appId}:_user`],
    queryFn: () => fetchAppRuntimeHealth(`${params.appId}:_user`),
    refetchInterval: 15_000,
    enabled: runtimeHealthEnabled,
  });

  const handleImageUpload = (file: File) => {
    uploadImage.mutate({
      path: { urn: `${params.appId}:_user` },
      body: { image: file },
    });
  };

  if (getApp.isLoading || !getApp.data) {
    return <PageLoadingSpinner />;
  }

  const { info, app, metadata } = getApp.data;

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
            <div className="flex w-full flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div className="mb-1">
                <AppStatus status={app?.status ?? 'missing'} runtimeHealth={runtimeHealth.data} variant="pill" />
              </div>
              <div className="min-w-0 xl:flex-1">
                <AppActions
                  app={app}
                  metadata={metadata}
                  info={info}
                  localDomain={userSettings.localDomain}
                  sslPort={userSettings.sslPort}
                  runtimeHealth={runtimeHealth.data}
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

export default CustomAppDetailsPage;
