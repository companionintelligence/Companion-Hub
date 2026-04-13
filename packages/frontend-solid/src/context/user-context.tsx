import { createContext, useContext, type ParentComponent } from 'solid-js';
import { createResource } from 'solid-js';
import { api, type UserContextDto } from '@/api-client';

const USER_CONTEXT_DEFAULTS: UserContextDto = {
  isLoggedIn: false,
  isPasswordResetDisabled: false,
  isGuestDashboardEnabled: false,
  isConfigured: false,
  domain: '',
  localDomain: '',
  sslPort: 443,
  allowErrorMonitoring: false,
  allowAutoThemes: false,
  themeBase: 'gray',
  themeColor: 'blue',
  version: { current: '0.0.0', latest: '0.0.0', body: '', releases: [] },
};

interface UserContextValue {
  userContext: () => UserContextDto;
  isLoading: () => boolean;
  refetch: () => void;
}

const UserCtx = createContext<UserContextValue>();

export const UserContextProvider: ParentComponent = (props) => {
  const [data, { refetch }] = createResource(() => api.getUserContext(), {
    initialValue: USER_CONTEXT_DEFAULTS,
  });

  const value: UserContextValue = {
    userContext: () => data() ?? USER_CONTEXT_DEFAULTS,
    isLoading: () => data.loading,
    refetch: () => {
      refetch();
    },
  };

  return <UserCtx.Provider value={value}>{props.children}</UserCtx.Provider>;
};

export const useUserContext = () => {
  const ctx = useContext(UserCtx);
  if (!ctx) throw new Error('useUserContext must be used within UserContextProvider');
  return ctx;
};
