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
const McpSettingsContainer = lazy(() => import('../containers/mcp-settings').then((module) => ({ default: module.McpSettingsContainer })));

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
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Tabs value={currentTab} onValueChange={handleTabChange} className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col">
          <div className="mx-auto flex w-full min-w-0 max-w-5xl justify-center">
            {/* One strip, not six tabs plus a "More" dropdown. The dropdown hid the
                active tab, lied to the tablist about how many tabs exist, and stopped
                arrow-key focus. The eight labels fit this column, so they stay centered
                and do not scroll: overflow-x-auto painted a scrollbar for the active
                tab's shadow and shifted the row off center. Below the md breakpoint the
                same labels are wider than a phone, so that pane still scrolls inside
                the strip instead of widening the page. */}
            <TabsList className="w-full min-w-0 max-w-full justify-center overflow-x-hidden border border-border/50 bg-card/50 max-md:justify-start max-md:overflow-x-auto max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden">
              <TabsTrigger value="settings">{t('COMMON_SETTINGS')}</TabsTrigger>
              <TabsTrigger value="security">{t('COMMON_SECURITY')}</TabsTrigger>
              <TabsTrigger value="appstores">{t('COMMON_APP_STORES')}</TabsTrigger>
              <TabsTrigger value="network">{t('COMMON_NETWORK')}</TabsTrigger>
              <TabsTrigger value="ai">{t('COMMON_AI')}</TabsTrigger>
              <TabsTrigger value="mcp">{t('COMMON_MCP')}</TabsTrigger>
              <TabsTrigger value="system">{t('COMMON_SYSTEM')}</TabsTrigger>
              <TabsTrigger value="logs">{t('COMMON_LOGS')}</TabsTrigger>
            </TabsList>
          </div>
          <div
            className={cn(
              'page-scroller-edge-3 relative min-h-0 min-w-0 flex-1 overflow-x-hidden py-3 pl-3',
              isLogsTab ? 'overflow-hidden' : 'overflow-y-auto',
            )}
            data-testid="settings-scroll-container"
            data-page-scroller="settings"
          >
            <div className={cn('mx-auto w-full min-w-0', isLogsTab ? 'h-full max-w-none' : 'max-w-5xl')}>
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
              <TabsContent value="mcp">
                {currentTab === 'mcp' && (
                  <Suspense fallback={<div>{t('SETTINGS_NETWORK_LOADING')}</div>}>
                    <McpSettingsContainer />
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
