import type { UserContextDto } from '@/api-client';
import { userContextOptions, userContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { isMobileClient } from '@/lib/mobile-connection';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo } from 'react';

interface UserContextValue extends UserContextDto {
  refreshUserContext: () => Promise<void>;
  setUserContext: (newUserContext: Partial<UserContextDto>) => void;
  isLoading: boolean;
}

const UserContext = createContext<UserContextValue | null>(null);

const USER_CONTEXT_DEFAULTS: UserContextDto = {
  isLoggedIn: false,
  isPasswordResetDisabled: false,
  isGuestDashboardEnabled: false,
  isConfigured: false,
  domain: '',
  localDomain: 'localhost',
  sslPort: 443,
  allowErrorMonitoring: false,
  allowAutoThemes: false,
  themeColor: 'blue',
  themeBase: 'gray',
  version: { current: '0.0.0', latest: '0.0.0', body: '', releases: [] },
} as UserContextDto;

export const UserContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();

  const queryKey = userContextQueryKey();
  const {
    data: userContext,
    error,
    isFetching,
    isLoading,
  } = useQuery({
    ...userContextOptions(),
    staleTime: 30_000,
    retry: isMobileClient() ? 0 : 3,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
  });

  if (error && !isFetching && !userContext) {
    // During desktop startup races, backend endpoints can briefly fail before
    // becoming ready. Keep defaults instead of crashing the entire UI.
    if (import.meta.env.DEV) {
      console.warn('userContext unavailable during startup, using defaults:', error);
    }
  }

  const refreshUserContext = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const resolvedContext = userContext ?? USER_CONTEXT_DEFAULTS;

  const value = useMemo(
    () => ({
      ...resolvedContext,
      isLoading,
      refreshUserContext,
      setUserContext: (newUserContext: Partial<UserContextDto>) => {
        queryClient.setQueryData(queryKey, { ...resolvedContext, ...newUserContext });
      },
    }),
    [resolvedContext, isLoading, refreshUserContext, queryClient, queryKey],
  );

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
};

export const useUserContext = () => {
  const context = useContext(UserContext);
  if (context === null) {
    throw new Error('useUserContext must be used within an UserContextProvider');
  }
  return context;
};
