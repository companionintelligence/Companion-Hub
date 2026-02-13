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
    <div className="d-flex flex-column h-100">
      <div className="d-flex justify-content-end align-items-center mb-4">
        <div className="d-flex gap-2">
          <button
            type="button"
            onClick={() => setDarkMode(true)}
            className={clsx('btn btn-icon', {
              'd-none': theme === 'dark',
            })}
            title={t('HEADER_DARK_MODE')}
          >
            <Moon size={24} />
          </button>
          <button
            type="button"
            onClick={() => setDarkMode(false)}
            className={clsx('btn btn-icon', {
              'd-none': theme === 'light',
            })}
            title={t('HEADER_LIGHT_MODE')}
          >
            <Sun size={24} />
          </button>
          <button type="button" onClick={handleLogout} className="btn btn-icon" title={t('HEADER_LOGOUT')}>
            <LogOut size={24} />
          </button>
          <button type="button" className="btn btn-icon btn-ghost-secondary" onClick={onClose} aria-label="Close">
            <X size={32} />
          </button>
        </div>
      </div>

      <div className="d-flex flex-column flex-grow-1 overflow-hidden">
        <Tabs value={currentTab} onValueChange={handleTabChange} className="flex-grow-1 d-flex flex-column h-100 overflow-hidden">
          <TabsList>
            <TabsTrigger value="settings">{t('SETTINGS_GENERAL_TAB_TITLE')}</TabsTrigger>
            <TabsTrigger value="security">{t('SETTINGS_SECURITY_TAB_TITLE')}</TabsTrigger>
            <TabsTrigger value="appstores" className="d-none d-md-block">
              {t('SETTINGS_APPSTORES_TAB_TITLE')}
            </TabsTrigger>
            <TabsTrigger value="logs" className="d-none d-md-block">
              {t('SETTINGS_LOGS_TAB_TITLE')}
            </TabsTrigger>
            <DropdownMenu>
              <DropdownMenuTrigger className="nav-link dropdown-toggle d-block d-md-none">{t('MORE')}</DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => handleTabChange('appstores')}>{t('SETTINGS_APPSTORES_TAB_TITLE')}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleTabChange('logs')}>{t('SETTINGS_LOGS_TAB_TITLE')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </TabsList>
          <div className="p-3 flex-grow-1 overflow-y-auto min-h-0" data-testid="settings-scroll-container">
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
