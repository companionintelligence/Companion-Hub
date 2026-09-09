import type { AppContextDto } from '@/api-client';
import { appContextOptions, appContextQueryKey, getUpdatesAvailableOptions, systemLoadOptions } from '@/api-client/@tanstack/react-query.gen';
import { FEATURED_STORE_SECTIONS, getFeaturedStoreSectionOptions } from '@/lib/featured-store-bundle-query';
import { getInstalledAppUrnsOptions } from '@/lib/installed-app-urns-query';
import { prefetchOnboardingMarketplace } from '@/modules/onboarding/helpers/prefetch-onboarding-marketplace';
import { isMobileClient } from '@/lib/mobile-connection';
import { type QueryClient, useQueryClient, useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect } from 'react';

interface AppContextValue extends AppContextDto {
  refreshAppContext: () => Promise<void>;
  setAppContext: (newAppContext: Partial<AppContextDto>) => void;
  isLoading: boolean;
  loadFailed: boolean;
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
  architecture: 'amd64',
  cloudflareAvailable: false,
  tailscaleAvailable: false,
  tailscaleNodeFqdn: undefined,
  tailscaleSupportsServices: false,
  tailscaleHttpsEnabled: false,
};

// Optimistically prefetch pages that are likely to be visited
const prefetch = async (queryClient: QueryClient) => {
  queryClient.ensureQueryData(systemLoadOptions());
};

const prefetchStoreShell = async (queryClient: QueryClient) => {
  await Promise.all([
    queryClient.ensureQueryData(getInstalledAppUrnsOptions()),
    ...FEATURED_STORE_SECTIONS.map((section) => queryClient.ensureQueryData(getFeaturedStoreSectionOptions(section.id))),
  ]);
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
    retry: isMobileClient() ? 0 : 3,
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

  const loadFailed = Boolean(error && !isFetching && !appContext);
  const resolved = appContext ?? APP_CONTEXT_DEFAULTS;

  useEffect(() => {
    if (isLoading || resolved.user.hasCompletedOnboarding) {
      return;
    }

    void prefetchOnboardingMarketplace(queryClient);
  }, [isLoading, queryClient, resolved.user.hasCompletedOnboarding]);

  useEffect(() => {
    if (isLoading || !resolved.user.hasCompletedOnboarding) {
      return;
    }

    void prefetchStoreShell(queryClient);
  }, [isLoading, queryClient, resolved.user.hasCompletedOnboarding]);

  // Fill update badge after paint — app-context no longer awaits the FS walk.
  const updatesQuery = useQuery({
    ...getUpdatesAvailableOptions(),
    enabled: !isLoading && Boolean(resolved.user.hasCompletedOnboarding),
    staleTime: 60_000,
  });

  useEffect(() => {
    const updatesAvailable = updatesQuery.data?.updatesAvailable;
    if (typeof updatesAvailable !== 'number') {
      return;
    }
    queryClient.setQueryData(appContextQueryKey(), (current: AppContextDto | undefined) => {
      const base = current ?? resolved;
      if (base.updatesAvailable === updatesAvailable) {
        return base;
      }
      return { ...base, updatesAvailable };
    });
  }, [queryClient, resolved, updatesQuery.data?.updatesAvailable]);

  const value = {
    ...resolved,
    updatesAvailable: updatesQuery.data?.updatesAvailable ?? resolved.updatesAvailable,
    isLoading,
    loadFailed,
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
