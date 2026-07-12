import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { PageLoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { useTranslation } from 'react-i18next';
import { PortExposeDetailsView } from '../components/port-expose-details-view/port-expose-details-view';
import { CustomAppDetailsPageContent } from './custom-app-details-page-content';

export const CustomAppDetailsPage = () => {
  const params = useParams<{ appId: string }>();
  const appId = params.appId;
  const { t } = useTranslation();
  const appUrn = appId ? `${appId}:_user` : '';

  const getApp = useQuery({
    ...getAppOptions({ path: { urn: appUrn } }),
    staleTime: 30_000,
    enabled: Boolean(appId),
  });

  if (!appId || getApp.isLoading) {
    return <PageLoadingSpinner />;
  }

  if (getApp.isError || !getApp.data) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold">{t('APP_ERROR_APP_NOT_FOUND', { id: appUrn })}</h1>
        <p className="mt-2 text-muted-foreground">{t('APP_DETAILS_LOAD_FAILED')}</p>
      </div>
    );
  }

  const { info, app, metadata } = getApp.data;

  if (isPortExposeApp(app?.config) || isPortExposeApp({ kind: (info as { kind?: 'port-expose' }).kind })) {
    if (!app) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-16 text-center">
          <h1 className="text-2xl font-semibold">{t('APP_ERROR_APP_NOT_FOUND', { id: appUrn })}</h1>
          <p className="mt-2 text-muted-foreground">{t('APP_DETAILS_LOAD_FAILED')}</p>
        </div>
      );
    }
    return <PortExposeDetailsView app={app} info={info} />;
  }

  return <CustomAppDetailsPageContent info={info} app={app} metadata={metadata} appId={appId} />;
};

export default CustomAppDetailsPage;
