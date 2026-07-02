import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAppContext } from '@/context/app-context';
import { cn } from '@/lib/utils';
import { Suspense, lazy, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { AppStoresContainer } from '../containers/app-stores-container';

const UserSettingsContainer = lazy(() => import('../containers/user-settings').then((module) => ({ default: module.UserSettingsContainer })));
const SecurityContainer = lazy(() => import('../containers/security').then((module) => ({ default: module.SecurityContainer })));
const LogsContainer = lazy(() => import('../containers/logs').then((module) => ({ default: module.LogsContainer })));
const NetworkSettingsContainer = lazy(() =>
  import('../containers/network-settings').then((module) => ({ default: module.NetworkSettingsContainer })),
);
const SystemInspectorContainer = lazy(() =>
  import('../containers/system-inspector').then((module) => ({ default: module.SystemInspectorContainer })),
);
const GeneralActionsContainer = lazy(() => import('../containers/general-actions').then((module) => ({ default: module.GeneralActionsContainer })));
const AiSettingsContainer = lazy(() => import('../containers/ai-settings').then((module) => ({ default: module.AiSettingsContainer })));

export default () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  const { userSettings, user } = useAppContext();

  const publicHubHostname = useMemo(() => {
    const domain = userSettings?.domain?.trim();
    const org = userSettings?.ciHubOrganizationSlug?.trim();
    const dev = userSettings?.ciHubDeviceSlug?.trim();
    if (!domain || !org || !dev) return '';
    return `hub-${dev}-${org}.${domain}`;
  }, [userSettings?.domain, userSettings?.ciHubOrganizationSlug, userSettings?.ciHubDeviceSlug]);

  const currentTab = tab || 'settings';
  const isLogsTab = currentTab === 'logs';

  const handleTabChange = (newTab: string) => {
    setSearchParams({ tab: newTab });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-col flex-1 overflow-hidden">
        <Tabs value={currentTab} onValueChange={handleTabChange} className="flex-1 flex flex-col h-full overflow-hidden">
          <div className="mx-auto flex w-full max-w-5xl justify-center">
            <TabsList className="bg-card/50 border border-border/50">
              <TabsTrigger value="settings">{t('COMMON_SETTINGS')}</TabsTrigger>
              <TabsTrigger value="security">{t('COMMON_SECURITY')}</TabsTrigger>
              <TabsTrigger value="appstores" className="hidden md:inline-flex">
                {t('COMMON_APP_STORES')}
              </TabsTrigger>
              <TabsTrigger value="network" className="hidden md:inline-flex">
                {t('COMMON_NETWORK')}
              </TabsTrigger>
              <TabsTrigger value="ai" className="hidden md:inline-flex">
                {t('COMMON_AI')}
              </TabsTrigger>
              <TabsTrigger value="system" className="hidden md:inline-flex">
                {t('COMMON_SYSTEM')}
              </TabsTrigger>
              <TabsTrigger value="logs" className="hidden md:inline-flex">
                {t('COMMON_LOGS')}
              </TabsTrigger>
              <DropdownMenu>
                <DropdownMenuTrigger className="inline-flex md:hidden items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                  {t('MORE')}
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => handleTabChange('appstores')}>{t('COMMON_APP_STORES')}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleTabChange('network')}>{t('COMMON_NETWORK')}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleTabChange('ai')}>{t('COMMON_AI')}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleTabChange('system')}>{t('COMMON_SYSTEM')}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleTabChange('logs')}>{t('COMMON_LOGS')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TabsList>
          </div>
          <div className={cn('p-3 flex-1 min-h-0', isLogsTab ? 'overflow-hidden' : 'overflow-y-auto')} data-testid="settings-scroll-container">
            <div className={cn('mx-auto w-full', isLogsTab ? 'h-full max-w-none' : 'max-w-5xl')}>
              <TabsContent value="settings">
                {currentTab === 'settings' && (
                  <Suspense fallback={<div>{t('SETTINGS_NETWORK_LOADING')}</div>}>
                    <UserSettingsContainer initialValues={userSettings} publicHubHostname={publicHubHostname} />
                  </Suspense>
                )}
              </TabsContent>
              <TabsContent value="security">
                {currentTab === 'security' && (
                  <Suspense fallback={<div>{t('SETTINGS_NETWORK_LOADING')}</div>}>
                    <SecurityContainer totpEnabled={Boolean(user.totpEnabled)} username={user.username} />
                  </Suspense>
                )}
              </TabsContent>
              <TabsContent value="appstores">
                {currentTab === 'appstores' && (
                  <Suspense fallback={<div>{t('SETTINGS_NETWORK_LOADING')}</div>}>
                    <AppStoresContainer />
                  </Suspense>
                )}
              </TabsContent>
              <TabsContent value="network">
                {currentTab === 'network' && (
                  <Suspense fallback={<div>{t('SETTINGS_NETWORK_LOADING')}</div>}>
                    <NetworkSettingsContainer />
                  </Suspense>
                )}
              </TabsContent>
              <TabsContent value="ai">
                {currentTab === 'ai' && (
                  <Suspense fallback={<div>{t('SETTINGS_NETWORK_LOADING')}</div>}>
                    <AiSettingsContainer />
                  </Suspense>
                )}
              </TabsContent>
              <TabsContent value="system">
                {currentTab === 'system' && (
                  <Suspense fallback={<div>{t('SETTINGS_NETWORK_LOADING')}</div>}>
                    <GeneralActionsContainer />
                    <div className="mt-6">
                      <SystemInspectorContainer />
                    </div>
                  </Suspense>
                )}
              </TabsContent>
              <TabsContent value="logs" className="mt-0 h-full">
                {currentTab === 'logs' && (
                  <Suspense fallback={<div>{t('SETTINGS_NETWORK_LOADING')}</div>}>
                    <LogsContainer />
                  </Suspense>
                )}
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </div>
    </div>
  );
};
