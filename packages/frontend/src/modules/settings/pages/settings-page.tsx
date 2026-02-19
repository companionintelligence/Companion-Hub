import { logoutMutation } from '@/api-client/@tanstack/react-query.gen';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAppContext } from '@/context/app-context';
import { useUIStore } from '@/stores/ui-store';
import { LogOut, Moon, Sun, X } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { AppStoresContainer } from '../containers/app-stores-container';

const UserSettingsContainer = lazy(() => import('../containers/user-settings').then((module) => ({ default: module.UserSettingsContainer })));
const SecurityContainer = lazy(() => import('../containers/security').then((module) => ({ default: module.SecurityContainer })));
const LogsContainer = lazy(() => import('../containers/logs').then((module) => ({ default: module.LogsContainer })));
const NetworkSettingsContainer = lazy(() =>
  import('../containers/network-settings').then((module) => ({ default: module.NetworkSettingsContainer })),
);

export default () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  const { userSettings, user } = useAppContext();

  const setDarkMode = useUIStore((state) => state.setDarkMode);
  const theme = useUIStore((state) => state.theme);

  const currentTab = tab || 'settings';

  const handleTabChange = (newTab: string) => {
    setSearchParams({ tab: newTab });
  };

  const logout = useMutation({
    ...logoutMutation(),
    onSuccess: () => {
      window.location.reload();
    },
  });

  const handleLogout = () => {
    logout.mutate({});
  };

  const onClose = () => {
    navigate('/dashboard');
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-end items-center mb-4">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setDarkMode(true)}
            className={clsx(
              'inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors',
              {
                hidden: theme === 'dark',
              },
            )}
            title={t('HEADER_DARK_MODE')}
          >
            <Moon size={24} />
          </button>
          <button
            type="button"
            onClick={() => setDarkMode(false)}
            className={clsx(
              'inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors',
              {
                hidden: theme === 'light',
              },
            )}
            title={t('HEADER_LIGHT_MODE')}
          >
            <Sun size={24} />
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            title={t('HEADER_LOGOUT')}
          >
            <LogOut size={24} />
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={32} />
          </button>
        </div>
      </div>

      <div className="flex flex-col flex-1 overflow-hidden">
        <Tabs value={currentTab} onValueChange={handleTabChange} className="flex-1 flex flex-col h-full overflow-hidden">
          <TabsList>
            <TabsTrigger value="settings">{t('SETTINGS_GENERAL_TAB_TITLE')}</TabsTrigger>
            <TabsTrigger value="security">{t('SETTINGS_SECURITY_TAB_TITLE')}</TabsTrigger>
            <TabsTrigger value="appstores" className="hidden md:inline-flex">
              {t('SETTINGS_APPSTORES_TAB_TITLE')}
            </TabsTrigger>
            <TabsTrigger value="network" className="hidden md:inline-flex">
              {t('SETTINGS_NETWORK_TAB_TITLE')}
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
                <DropdownMenuItem onClick={() => handleTabChange('logs')}>{t('SETTINGS_LOGS_TAB_TITLE')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </TabsList>
          <div className="p-3 flex-1 overflow-y-auto min-h-0" data-testid="settings-scroll-container">
            <TabsContent value="settings">
              <Suspense fallback={<div>Loading...</div>}>
                <UserSettingsContainer initialValues={userSettings} />
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
            <TabsContent value="logs">
              <Suspense fallback={<div>Loading...</div>}>
                <LogsContainer />
              </Suspense>
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
};
