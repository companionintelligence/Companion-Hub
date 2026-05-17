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
          <div className="max-w-3xl mx-auto w-full">
            <TabsList className="bg-card/50 border border-border/50">
              <TabsTrigger value="settings">{t('SETTINGS_GENERAL_TAB_TITLE')}</TabsTrigger>
              <TabsTrigger value="security">{t('SETTINGS_SECURITY_TAB_TITLE')}</TabsTrigger>
              <TabsTrigger value="appstores" className="hidden md:inline-flex">
                {t('SETTINGS_APPSTORES_TAB_TITLE')}
              </TabsTrigger>
              <TabsTrigger value="network" className="hidden md:inline-flex">
                {t('SETTINGS_NETWORK_TAB_TITLE')}
              </TabsTrigger>
              <TabsTrigger value="ai" className="hidden md:inline-flex">
                AI
              </TabsTrigger>
              <TabsTrigger value="system" className="hidden md:inline-flex">
                System
              </TabsTrigger>
              <TabsTrigger value="logs" className="hidden md:inline-flex">
                {t('SETTINGS_LOGS_TAB_TITLE')}
              </TabsTrigger>
              <DropdownMenu>
                <DropdownMenuTrigger className="inline-flex md:hidden items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                  {t('MORE')}
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => handleTabChange('appstores')}>{t('SETTINGS_APPSTORES_TAB_TITLE')}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleTabChange('network')}>{t('SETTINGS_NETWORK_TAB_TITLE')}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleTabChange('ai')}>AI</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleTabChange('system')}>System</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleTabChange('logs')}>{t('SETTINGS_LOGS_TAB_TITLE')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TabsList>
          </div>
          <div className={cn('p-3 flex-1 min-h-0', isLogsTab ? 'overflow-hidden' : 'overflow-y-auto')} data-testid="settings-scroll-container">
            <div className={cn('mx-auto w-full', isLogsTab ? 'h-full max-w-none' : 'max-w-3xl')}>
              <TabsContent value="settings">
                <Suspense fallback={<div>Loading...</div>}>
                  <UserSettingsContainer initialValues={userSettings} publicHubHostname={publicHubHostname} />
                </Suspense>
              </TabsContent>
              <TabsContent value="security">
                <Suspense fallback={<div>Loading...</div>}>
                  <SecurityContainer totpEnabled={Boolean(user.totpEnabled)} username={user.username} />
                </Suspense>
              </TabsContent>
              <TabsContent value="appstores">
                <Suspense fallback={<div>Loading...</div>}>
                  <AppStoresContainer />
                </Suspense>
              </TabsContent>
              <TabsContent value="network">
                <Suspense fallback={<div>Loading...</div>}>
                  <NetworkSettingsContainer />
                </Suspense>
              </TabsContent>
              <TabsContent value="ai">
                <Suspense fallback={<div>Loading...</div>}>
                  <AiSettingsContainer />
                </Suspense>
              </TabsContent>
              <TabsContent value="system">
                <Suspense fallback={<div>Loading...</div>}>
                  <GeneralActionsContainer />
                  <div className="mt-6">
                    <SystemInspectorContainer />
                  </div>
                </Suspense>
              </TabsContent>
              <TabsContent value="logs" className="mt-0 h-full">
                <Suspense fallback={<div>Loading...</div>}>
                  <LogsContainer />
                </Suspense>
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </div>
    </div>
  );
};
