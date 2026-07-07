import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { PageLoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { PortExposeDetailsView } from '../components/port-expose-details-view/port-expose-details-view';
import { CustomAppDetailsPageContent } from './custom-app-details-page-content';

export const CustomAppDetailsPage = () => {
  const params = useParams<{ appId: string }>();
  const appId = params.appId;

  const getApp = useQuery({
    ...getAppOptions({ path: { urn: `${appId}:_user` } }),
    staleTime: 30_000,
    enabled: Boolean(appId),
  });

  if (!appId || getApp.isLoading || !getApp.data) {
    return <PageLoadingSpinner />;
  }

  const { info, app, metadata } = getApp.data;

  if (isPortExposeApp(app?.config) || isPortExposeApp({ kind: (info as { kind?: 'port-expose' }).kind })) {
    if (!app) {
      return <PageLoadingSpinner />;
    }
    return <PortExposeDetailsView app={app} info={info} />;
  }

  return <CustomAppDetailsPageContent info={info} app={app} metadata={metadata} appId={appId} />;
};

export default CustomAppDetailsPage;
