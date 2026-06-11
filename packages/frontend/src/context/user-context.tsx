import type { UserContextDto } from '@/api-client';
import { userContextOptions, userContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { captureHubWarning } from '@/lib/sentry';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';

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
  localDomain: 'ci.lan',
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
  });

  if (error && !isFetching && !userContext) {
    // During desktop startup races, backend endpoints can briefly fail before
    // becoming ready. Keep defaults instead of crashing the entire UI.
    console.warn('userContext unavailable during startup, using defaults:', error);
    captureHubWarning(
      'userContext unavailable during startup; using defaults',
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { dedupeKey: 'user-context-startup-unavailable' },
    );
  }

  const refreshUserContext = async () => {
    await queryClient.invalidateQueries({ queryKey });
  };

  const resolvedContext = userContext ?? USER_CONTEXT_DEFAULTS;

  const value = {
    ...resolvedContext,
    isLoading,
    refreshUserContext: refreshUserContext,
    setUserContext: (newUserContext: Partial<UserContextDto>) => {
      queryClient.setQueryData(['userContext'], { ...resolvedContext, ...newUserContext });
    },
  };

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
};

export const useUserContext = () => {
  const context = useContext(UserContext);
  if (context === null) {
    throw new Error('useUserContext must be used within an UserContextProvider');
  }
  return context;
};
