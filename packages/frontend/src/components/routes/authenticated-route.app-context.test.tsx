import { render, screen } from '@/tests/test-utils';
import { sdkOk } from '@/tests/sdk-mock-helpers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuthenticatedRoute from './authenticated-route';

const { appContextQueryFn, captureHubException, getRehydrateStatus, session, outlet } = vi.hoisted(() => ({
  appContextQueryFn: vi.fn(),
  captureHubException: vi.fn(),
  getRehydrateStatus: vi.fn(),
  session: { isLoggedIn: true, isGuestDashboardEnabled: false },
  outlet: { element: null as React.ReactNode },
}));

vi.mock('@/api-client/sdk.gen', () => ({ getRehydrateStatus }));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  appContextOptions: () => ({ queryKey: ['app-context'], queryFn: appContextQueryFn }),
  appContextQueryKey: () => ['app-context'],
  getUpdatesAvailableOptions: () => ({ queryKey: ['updates-available'], queryFn: async () => ({ updatesAvailable: 0 }) }),
  systemLoadOptions: () => ({ queryKey: ['system-load'], queryFn: async () => null }),
  getGuestAppsOptions: () => ({ queryKey: ['guest-apps'], queryFn: async () => ({ installed: [] }) }),
  getGuestLinksOptions: () => ({ queryKey: ['guest-links'], queryFn: async () => ({ links: [] }) }),
  logoutMutation: () => ({ mutationFn: vi.fn() }),
}));
vi.mock('@/lib/featured-store-bundle-query', () => ({ FEATURED_STORE_SECTIONS: [], getFeaturedStoreSectionOptions: vi.fn() }));
vi.mock('@/lib/installed-app-urns-query', () => ({
  getInstalledAppUrnsOptions: () => ({ queryKey: ['installed-app-urns'], queryFn: async () => ({ urns: [] }) }),
}));
vi.mock('@/modules/onboarding/helpers/prefetch-onboarding-marketplace', () => ({ prefetchOnboardingMarketplace: vi.fn() }));
vi.mock('@/context/user-context', () => ({ useUserContext: () => ({ ...session, isLoading: false, sslPort: 443 }) }));
vi.mock('react-router', async () => ({
  ...(await vi.importActual<typeof import('react-router')>('react-router')),
  useOutlet: () => outlet.element,
}));
vi.mock('../layouts/dashboard/layout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../layouts/dashboard/layout')>()),
  DashboardLayout: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../providers/sse/sse-provider', () => ({ SSEProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./route-wrapper', () => ({ RouteWrapper: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/mode-toggle', () => ({ ModeToggle: () => null }));
vi.mock('@/lib/sentry', () => ({ captureHubException }));

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const PageThatFails = () => {
  throw new Error('page failed');
};

function renderRoute() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthenticatedRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AuthenticatedRoute and the app context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    session.isLoggedIn = true;
    session.isGuestDashboardEnabled = false;
    outlet.element = <div data-testid="outlet" />;
    getRehydrateStatus.mockResolvedValue(sdkOk({ completed: false, restoreIntent: false, checking: false, noticePending: false }));
    appContextQueryFn.mockResolvedValue({ user: { hasCompletedOnboarding: true }, userSettings: {}, apps: [], updatesAvailable: 0 });
    // React logs a page that throws before the error boundary takes it.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the header on the error page when a page inside the shell fails', async () => {
    outlet.element = <PageThatFails />;

    renderRoute();

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByTestId('app-header')).toBeInTheDocument();
    expect(captureHubException).toHaveBeenCalledWith(expect.objectContaining({ message: 'page failed' }), expect.anything());
  });

  it('shows a signed-out visitor the guest dashboard under its header, without asking for the app context', async () => {
    session.isLoggedIn = false;
    session.isGuestDashboardEnabled = true;

    renderRoute();

    expect(await screen.findByTestId('app-header')).toBeInTheDocument();
    expect(appContextQueryFn).not.toHaveBeenCalled();
  });
});
