import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContextProvider, GuestAppContextProvider, useAppContext } from './app-context';

const { appContextQueryFn, hubDown } = vi.hoisted(() => ({
  appContextQueryFn: vi.fn(),
  hubDown: () => Promise.reject(new TypeError('Failed to fetch')),
}));

// Every request the provider warms up fails, as when the Hub is restarting or the computer just woke.
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  appContextOptions: () => ({ queryKey: ['app-context'], queryFn: appContextQueryFn }),
  appContextQueryKey: () => ['app-context'],
  getUpdatesAvailableOptions: () => ({ queryKey: ['updates-available'], queryFn: async () => ({ updatesAvailable: 0 }) }),
  systemLoadOptions: () => ({ queryKey: ['system-load'], queryFn: hubDown }),
  searchAppsOptions: () => ({ queryKey: ['search-apps'], queryFn: hubDown }),
}));
vi.mock('@/lib/featured-store-bundle-query', () => ({
  FEATURED_STORE_SECTIONS: [{ id: 'featured' }, { id: 'trending' }],
  getFeaturedStoreSectionOptions: (id: string) => ({
    queryKey: ['featured-section', id],
    queryFn: () => Promise.reject(new Error('Failed to load store listings (0)')),
  }),
}));
vi.mock('@/lib/installed-app-urns-query', () => ({ getInstalledAppUrnsOptions: () => ({ queryKey: ['installed-app-urns'], queryFn: hubDown }) }));
vi.mock('@/lib/portal-alternatives', () => ({ portalAlternativesQueryOptions: () => ({ queryKey: ['alternatives'], queryFn: hubDown }) }));
vi.mock('@/lib/portal-store', () => ({ portalStoreListingsQueryOptions: () => ({ queryKey: ['listings'], queryFn: hubDown }) }));

const Probe = () => {
  const { isLoading, loadFailed, user } = useAppContext();
  return <p>{`loading:${isLoading} failed:${loadFailed} onboarded:${Boolean(user.hasCompletedOnboarding)}`}</p>;
};

describe('AppContextProvider warm-ups', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it.each([
    ['an onboarded Hub', true],
    ['a Hub still being set up', false],
  ])('leaves no rejection unhandled when the Hub cannot be reached on %s', async (_kind, hasCompletedOnboarding) => {
    appContextQueryFn.mockResolvedValue({ user: { hasCompletedOnboarding }, userSettings: {}, apps: [], updatesAvailable: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AppContextProvider>
          <Probe />
        </AppContextProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(`loading:false failed:false onboarded:${hasCompletedOnboarding}`)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(unhandled).toEqual([]);
  });
});

describe('GuestAppContextProvider', () => {
  it('serves the defaults without asking the Hub for the app context', () => {
    appContextQueryFn.mockClear();

    render(
      <QueryClientProvider client={new QueryClient()}>
        <GuestAppContextProvider>
          <Probe />
        </GuestAppContextProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByText('loading:false failed:false onboarded:false')).toBeInTheDocument();
    expect(appContextQueryFn).not.toHaveBeenCalled();
  });
});

describe('useAppContext', () => {
  it('still refuses to run outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<Probe />)).toThrow('useAppContext must be used within an AppContextProvider');

    vi.restoreAllMocks();
  });
});
