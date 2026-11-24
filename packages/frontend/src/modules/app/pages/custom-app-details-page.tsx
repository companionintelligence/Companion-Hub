import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { PageLoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { useTranslation } from 'react-i18next';
import { EmptyPage } from '@/components/empty-page/empty-page';
import type { TranslatableError } from '@/types/error.types';
import { PortExposeDetailsView } from '../components/port-expose-details-view/port-expose-details-view';
import { useCustomAppAccess } from '../helpers/use-custom-app-access';
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
  // Ask what this person may do while the app loads, not after: the page's controls wait on the answer,
  // and asked from the content alone it queued behind the page's other requests for seconds.
  useCustomAppAccess();

  if (!appId || getApp.isLoading) {
    return <PageLoadingSpinner />;
  }

  if (getApp.isError || !getApp.data) {
    // A custom app never came from a store, and the URN means nothing to the person reading it.
    const error = getApp.error as TranslatableError | null;
    const missing = !getApp.isError || error?.http?.status === 404 || error?.message === 'APP_ERROR_APP_NOT_FOUND';
    return (
      <div className="mx-auto max-w-6xl" data-testid="custom-app-unavailable">
        <EmptyPage
          title={missing ? t('CUSTOM_APP_NOT_FOUND_TITLE') : t('CUSTOM_APP_LOAD_FAILED_TITLE')}
          subtitle={missing ? t('CUSTOM_APP_NOT_FOUND_SUBTITLE', { name: appId }) : t('CUSTOM_APP_LOAD_FAILED_SUBTITLE')}
          redirectPath="/home"
          actionLabel="COMMON_HOME"
        />
      </div>
    );
  }

  const { info, app, metadata, failure } = getApp.data;

  if (isPortExposeApp(app?.config) || isPortExposeApp({ kind: (info as { kind?: 'port-expose' }).kind })) {
    if (!app) {
      return (
        <div className="mx-auto max-w-6xl" data-testid="custom-app-unavailable">
          <EmptyPage
            title={t('CUSTOM_APP_NOT_FOUND_TITLE')}
            subtitle={t('CUSTOM_APP_NOT_FOUND_SUBTITLE', { name: appId })}
            redirectPath="/home"
            actionLabel="COMMON_HOME"
          />
        </div>
      );
    }
    return <PortExposeDetailsView app={app} info={info} />;
  }

  return <CustomAppDetailsPageContent info={info} app={app} metadata={metadata} failure={failure} appId={appId} />;
};

export default CustomAppDetailsPage;
