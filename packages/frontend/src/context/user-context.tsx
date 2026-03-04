import type { UserContextDto } from '@/api-client';
import { userContextOptions, userContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
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
  localDomain: '',
  sslPort: 443,
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

  if (error && !isFetching) {
    throw error;
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
