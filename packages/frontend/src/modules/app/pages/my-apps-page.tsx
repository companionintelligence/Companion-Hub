import { Link, useNavigate } from 'react-router';
import { getInstalledAppsOptions, getLinksOptions } from '@/api-client/@tanstack/react-query.gen';
import { EmptyPage } from '@/components/empty-page/empty-page';
import type { CustomLink } from '@/types/app.types';
import { useSuspenseQuery } from '@tanstack/react-query';
import { AppTile } from '../components/app-tile/app-tile';
import { LinkTile } from '../components/link-tile/link-tile';
import { ButtonTile } from '../components/button-tile/button-tile';
import { AppWindow, Link as LinkIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import { AddLinkDialog } from '../components/dialogs/add-link/add-link-dialog';
import '@/styles/app-grid.css';

export default () => {
  const { data: apps } = useSuspenseQuery({
    ...getInstalledAppsOptions(),
  });

  const { data: links } = useSuspenseQuery({
    ...getLinksOptions(),
  });

  const addLinkDisclosure = useDisclosure();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const { installed } = apps;
  const { links: customLinks = [] } = links;

  const renderApp = ({ info, app, metadata }: (typeof installed)[number]) => {
    const versionIsIgnored = app.ignoredVersion === metadata.latestVersion;
    const updateAvailable = Number(app.version) < Number(metadata.latestVersion) && !versionIsIgnored;

    const [appName, storeId] = info.urn.split(':');

    if (info.available) {
      return (
        <Link key={app.id} to={`/apps/${storeId}/${appName}`} className="app-link" data-testid={`installed-app-${appName}`}>
          <AppTile key={info.urn} status={app.status} info={info} updateAvailable={updateAvailable} pendingRestart={app.pendingRestart} />
        </Link>
      );
    }

    return null;
  };

  const renderLink = (link: CustomLink) => {
    return (
      <Link key={link.id} to={link.url} target="_blank" className="app-link">
        <LinkTile key={link.id} link={link} />
      </Link>
    );
  };

  return (
    <div className="h-full flex flex-col px-6 pt-4">
      <div className="flex-shrink-0 mb-6">
        <h2 className="text-3xl font-bold tracking-tight mb-1 text-foreground">My Apps</h2>
        <p className="text-lg text-muted-foreground">Manage your installed applications and links</p>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0" data-testid="my-apps-scroll-container">
        {installed.length === 0 && customLinks.length === 0 ? (
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="apps-list">
            {installed.map(renderApp)}
            {customLinks.map(renderLink)}
            <ButtonTile
              title={t('CUSTOM_APP_ADD_TITLE')}
              subtitle={t('CUSTOM_APP_ADD_SUBTITLE')}
              action={() => navigate('/apps/create')}
              icon={<AppWindow size={50} strokeWidth={1.5} />}
            />
            <ButtonTile
              title={t('LINKS_ADD_TITLE')}
              subtitle={t('LINKS_ADD_SUBTITLE')}
              action={() => addLinkDisclosure.open()}
              icon={<LinkIcon size={50} strokeWidth={1.5} />}
            />
          </div>
        )}
      </div>
      <AddLinkDialog isOpen={addLinkDisclosure.isOpen} onClose={() => addLinkDisclosure.close()} />
    </div>
  );
};
