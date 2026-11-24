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
  it('seeds error monitoring as off, the backend opt-in default, until the Hub has answered', () => {
    // Reporting is opt-in on the backend: the fallback in AppController.userContext is false, and
    // nothing reports until the user turns the switch on. The seed matches that default.
    const { result } = renderUserContext();

    expect(result.current.allowErrorMonitoring).toBe(false);
  });

  it('reports the pre-load window as loading, so a consumer can tell it from a real answer', () => {
    const { result } = renderUserContext();

    expect(result.current.isLoading).toBe(true);
  });
});
