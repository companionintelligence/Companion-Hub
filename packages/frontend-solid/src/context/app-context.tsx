import { createContext, useContext, type ParentComponent } from 'solid-js';
import { createResource } from 'solid-js';
import { api, type AppContextDto } from '@/api-client';

const APP_CONTEXT_DEFAULTS: AppContextDto = {
  version: { current: '0.0.0', latest: '0.0.0', body: '', releases: [] },
  userSettings: {} as AppContextDto['userSettings'],
  user: { hasCompletedOnboarding: false } as AppContextDto['user'],
  apps: [],
  updatesAvailable: 0,
  isProduction: true,
  cloudflareAvailable: false,
  tailscaleAvailable: false,
};

interface AppContextValue {
  appContext: () => AppContextDto;
  isLoading: () => boolean;
  refetch: () => void;
}

const AppCtx = createContext<AppContextValue>();

export const AppContextProvider: ParentComponent = (props) => {
  const [data, { refetch }] = createResource(() => api.getAppContext(), {
    initialValue: APP_CONTEXT_DEFAULTS,
  });

  const value: AppContextValue = {
    appContext: () => data() ?? APP_CONTEXT_DEFAULTS,
    isLoading: () => data.loading,
    refetch: () => {
      refetch();
    },
  };

  return <AppCtx.Provider value={value}>{props.children}</AppCtx.Provider>;
};

export const useAppContext = () => {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useAppContext must be used within AppContextProvider');
  return ctx;
};
