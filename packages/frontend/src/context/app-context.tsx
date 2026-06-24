import type { AppContextDto } from '@/api-client';
import { appContextOptions, appContextQueryKey, searchAppsInfiniteOptions, systemLoadOptions } from '@/api-client/@tanstack/react-query.gen';
import { type QueryClient, useQueryClient, useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect } from 'react';

interface AppContextValue extends AppContextDto {
  refreshAppContext: () => Promise<void>;
  setAppContext: (newAppContext: Partial<AppContextDto>) => void;
  isLoading: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

// Sensible defaults while app-context is loading
const APP_CONTEXT_DEFAULTS: AppContextDto = {
  version: { current: '0.0.0', latest: '0.0.0', body: '', releases: [] },
  userSettings: {} as AppContextDto['userSettings'],
  user: { hasCompletedOnboarding: false } as AppContextDto['user'],
  apps: [],
  updatesAvailable: 0,
  isProduction: true,
  cloudflareAvailable: false,
  tailscaleAvailable: false,
  tailscaleNodeFqdn: null,
  tailscaleSupportsServices: false,
};

// Optimistically prefetch pages that are likely to be visited
const prefetch = async (queryClient: QueryClient) => {
  queryClient.ensureInfiniteQueryData(searchAppsInfiniteOptions());
  queryClient.ensureQueryData(systemLoadOptions());
};

export const AppContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();

  useEffect(() => {
    prefetch(queryClient);
  }, [queryClient]);

  const queryKey = appContextQueryKey();
  const {
    data: appContext,
    error,
    isFetching,
    isLoading,
  } = useQuery({
    ...appContextOptions(),
    staleTime: 30_000, // 30 seconds — don't refetch on every navigation
    retry: 3,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
  });

  if (error && !isFetching && !appContext) {
    // During desktop startup races, backend endpoints can briefly fail before
    // becoming ready. Keep defaults instead of crashing the entire UI.
    if (import.meta.env.DEV) {
      console.warn('appContext unavailable during startup, using defaults:', error);
    }
  }

  const refreshAppContext = async () => {
    await queryClient.invalidateQueries({ queryKey });
  };

  const resolved = appContext ?? APP_CONTEXT_DEFAULTS;

  const value = {
    ...resolved,
    isLoading,
    refreshAppContext,
    setAppContext: (newAppContext: Partial<AppContextDto>) => {
      queryClient.setQueryData(appContextQueryKey(), (current: AppContextDto | undefined) => {
        const base = current ?? resolved;
        return {
          ...base,
          ...newAppContext,
          user: newAppContext.user ? { ...base.user, ...newAppContext.user } : base.user,
        };
      });
    },
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (context === null) {
    throw new Error('useAppContext must be used within an AppContextProvider');
  }
  return context;
};
