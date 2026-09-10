import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// A request that never settles is exactly the cold-start window USER_CONTEXT_DEFAULTS exists for.
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  userContextQueryKey: () => ['userContext'],
  userContextOptions: () => ({ queryKey: ['userContext'], queryFn: () => new Promise(() => {}) }),
}));

import { UserContextProvider, useUserContext } from './user-context';

function renderUserContext() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return renderHook(() => useUserContext(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <UserContextProvider>{children}</UserContextProvider>
      </QueryClientProvider>
    ),
  });
}

describe('UserContextProvider — pre-load defaults', () => {
  it('MUST NOT claim error monitoring is off before the Hub has answered', () => {
    // Reporting is opt-out on the backend (DEFAULT_ALLOW_ERROR_MONITORING is 'true', and both
    // branches of AppController.userContext fall back to true), so seeding `false` showed the
    // consent switch as off on every cold start while the Hub was in fact reporting.
    const { result } = renderUserContext();

    expect(result.current.allowErrorMonitoring).toBe(true);
  });

  it('reports the pre-load window as loading, so a consumer can tell it from a real answer', () => {
    const { result } = renderUserContext();

    expect(result.current.isLoading).toBe(true);
  });
});
