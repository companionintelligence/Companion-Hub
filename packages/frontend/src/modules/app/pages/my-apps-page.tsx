import { Link, useNavigate } from 'react-router';
import { getInstalledAppsOptions, getLinksOptions } from '@/api-client/@tanstack/react-query.gen';
import { EmptyPage } from '@/components/empty-page/empty-page';
import type { CustomLink } from '@/types/app.types';
import { useQuery } from '@tanstack/react-query';
import { AppTile } from '../components/app-tile/app-tile';
import { LinkTile } from '../components/link-tile/link-tile';
import { ButtonTile } from '../components/button-tile/button-tile';
import { AppWindow, Link as LinkIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import { AddLinkDialog } from '../components/dialogs/add-link/add-link-dialog';
import '@/styles/app-grid.css';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { QueuedInstallsIndicator } from '@/modules/dashboard/components/queued-installs-indicator';
import { useInstallQueue } from '@/modules/app/helpers/use-install-queue';

export default () => {
  const { data: apps, isLoading: appsLoading } = useQuery({
    ...getInstalledAppsOptions(),
    staleTime: 30_000,
  });

  const { data: links, isLoading: linksLoading } = useQuery({
    ...getLinksOptions(),
    staleTime: 30_000,
  });

  const addLinkDisclosure = useDisclosure();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const installed = apps?.installed ?? [];
  const customLinks = links?.links ?? [];
  const installingCount = installed.filter((entry) => entry.app.status === 'installing').length;
  const { data: installQueue, isLoading: installQueueLoading } = useInstallQueue(installingCount > 0);

  const renderApp = ({ info, app, metadata }: (typeof installed)[number]) => {
    const versionIsIgnored = app.ignoredVersion === metadata.latestVersion;
    const updateAvailable = Number(app.version) < Number(metadata.latestVersion) && !versionIsIgnored;

    const [appName, storeId] = info.urn.split(':');

    return (
      <Link key={app.id} to={`/apps/${storeId}/${appName}`} className="app-link" data-testid={`installed-app-${appName}`}>
        <AppTile
          key={info.urn}
          status={app.status}
          info={info}
          updateAvailable={updateAvailable}
          pendingRestart={app.pendingRestart}
          available={info.available}
          installConfig={app.config}
        />
      </Link>
    );
  };

  const renderLink = (link: CustomLink) => {
    return (
      <div key={link.id} data-testid={`custom-link-${link.id}`}>
        <LinkTile key={link.id} link={link} />
      </div>
    );
  };

  const hasApps = installed.length > 0;
  const hasLinks = customLinks.length > 0;
  const hasBoth = hasApps && hasLinks;

  return (
    <div className="h-full flex flex-col px-6 pt-4">
      <div className="flex-shrink-0 mb-6">
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-1 text-foreground">My Apps</h2>
        <p className="text-lg text-muted-foreground">Manage your installed applications and links</p>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0" data-testid="my-apps-scroll-container">
        {(appsLoading || linksLoading) && !apps && !links ? (
          <LoadingSpinner />
        ) : !hasApps && !hasLinks ? (
          <EmptyPage
            title="MY_APPS_EMPTY_TITLE"
            subtitle="MY_APPS_EMPTY_SUBTITLE"
            redirectPath="/app-store"
            actionLabel="MY_APPS_EMPTY_ACTION"
            extraContent={
              <div className="flex flex-col sm:flex-row gap-2 justify-center">
                <ButtonTile
                  title={t('CUSTOM_APP_ADD_TITLE')}
                  subtitle={t('CUSTOM_APP_ADD_SUBTITLE')}
                  action={() => navigate('/apps/create')}
                  icon={<AppWindow size={50} strokeWidth={1.5} color="#A4A4A4" />}
                  className="w-full sm:w-1/2"
                />
                <ButtonTile
                  title={t('LINKS_ADD_TITLE')}
                  subtitle={t('LINKS_ADD_SUBTITLE')}
                  action={() => addLinkDisclosure.open()}
                  icon={<LinkIcon size={50} strokeWidth={1.5} color="#A4A4A4" />}
                  className="w-full sm:w-1/2"
                />
              </div>
            }
          />
        ) : (
          <div className="space-y-6">
            {hasApps && (
              <div>
                {hasBoth && (
                  <h3 className="text-lg font-semibold mb-3 text-foreground" data-testid="section-apps">
                    {t('MY_APPS_SECTION_APPS')}
                  </h3>
                )}
                <QueuedInstallsIndicator queue={installQueue} isLoading={installQueueLoading && installingCount > 0} />
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="apps-list">
                  {installed.map(renderApp)}
                  <ButtonTile
                    title={t('CUSTOM_APP_ADD_TITLE')}
                    subtitle={t('CUSTOM_APP_ADD_SUBTITLE')}
                    action={() => navigate('/apps/create')}
                    icon={<AppWindow size={50} strokeWidth={1.5} />}
                  />
                </div>
              </div>
            )}
            {hasLinks && (
              <div>
                {hasBoth && (
                  <h3 className="text-lg font-semibold mb-3 text-foreground" data-testid="section-links">
                    {t('MY_APPS_SECTION_LINKS')}
                  </h3>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="links-list">
                  {customLinks.map(renderLink)}
                  <ButtonTile
                    title={t('LINKS_ADD_TITLE')}
                    subtitle={t('LINKS_ADD_SUBTITLE')}
                    action={() => addLinkDisclosure.open()}
                    icon={<LinkIcon size={50} strokeWidth={1.5} />}
                  />
                </div>
              </div>
            )}
            {!hasBoth && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {!hasApps && (
                  <ButtonTile
                    title={t('CUSTOM_APP_ADD_TITLE')}
                    subtitle={t('CUSTOM_APP_ADD_SUBTITLE')}
                    action={() => navigate('/apps/create')}
                    icon={<AppWindow size={50} strokeWidth={1.5} />}
                  />
                )}
                {!hasLinks && (
                  <ButtonTile
                    title={t('LINKS_ADD_TITLE')}
                    subtitle={t('LINKS_ADD_SUBTITLE')}
                    action={() => addLinkDisclosure.open()}
                    icon={<LinkIcon size={50} strokeWidth={1.5} />}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <AddLinkDialog isOpen={addLinkDisclosure.isOpen} onClose={() => addLinkDisclosure.close()} />
    </div>
  );
};
