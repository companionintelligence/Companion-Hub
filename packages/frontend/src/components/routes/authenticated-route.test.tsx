import { render, screen } from '@/tests/test-utils';
import { sdkOk } from '@/tests/sdk-mock-helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuthenticatedRoute from './authenticated-route';

const { getRehydrateStatus, appContext } = vi.hoisted(() => ({
  getRehydrateStatus: vi.fn(),
  appContext: {
    user: { hasCompletedOnboarding: false } as { hasCompletedOnboarding: boolean; username?: string },
    isLoading: false,
    loadFailed: false,
  },
}));

vi.mock('@/api-client/sdk.gen', () => ({ getRehydrateStatus }));
vi.mock('@/context/user-context', () => ({
  useUserContext: () => ({ isLoggedIn: true, isGuestDashboardEnabled: false, isLoading: false }),
}));
vi.mock('@/context/app-context', () => ({
  AppContextProvider: ({ children }: { children: React.ReactNode }) => children,
  GuestAppContextProvider: ({ children }: { children: React.ReactNode }) => children,
  useAppContext: () => appContext,
}));
vi.mock('react-router', async () => ({
  ...(await vi.importActual<typeof import('react-router')>('react-router')),
  Navigate: ({ to }: { to: string }) => <div data-testid={`navigate-${to}`} />,
  useLocation: () => ({ pathname: '/home' }),
  useOutlet: () => <div data-testid="outlet" />,
}));
vi.mock('../layouts/dashboard/layout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => children,
  DashboardLayoutSuspense: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../providers/sse/sse-provider', () => ({ SSEProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./route-wrapper', () => ({ RouteWrapper: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/modules/dashboard/pages/guest-dashboard', () => ({ GuestDashboard: () => null }));
vi.mock('@/lib/sentry', () => ({ captureHubException: vi.fn() }));

const status = (overrides: Record<string, unknown>) =>
  sdkOk({ completed: false, restoreIntent: false, checking: false, noticePending: false, ...overrides });

/*
 * The Hub restores a device's apps right after pairing, with nobody signed in. The first sign-in used
 * to reach the restore page only from the browser that chose "Restore existing device"; from anywhere
 * else it got the setup wizard on a Hub that already had its apps.
 */
describe('AuthenticatedRoute after a pairing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    appContext.user = { hasCompletedOnboarding: false };
  });

  it('opens the restore summary instead of the setup wizard when the Hub restored apps nobody has seen', async () => {
    getRehydrateStatus.mockResolvedValue(status({ completed: true, noticePending: true }));

    render(<AuthenticatedRoute />);

    expect(await screen.findByTestId('navigate-/restore-apps')).toBeInTheDocument();
    expect(screen.queryByTestId('navigate-/onboarding')).not.toBeInTheDocument();
  });

  it('waits on the restore page while the apps check has not decided yet', async () => {
    getRehydrateStatus.mockResolvedValue(status({ checking: true }));

    render(<AuthenticatedRoute />);

    expect(await screen.findByTestId('navigate-/restore-apps')).toBeInTheDocument();
  });

  it('opens the setup wizard when the pairing had nothing to restore', async () => {
    getRehydrateStatus.mockResolvedValue(status({}));

    render(<AuthenticatedRoute />);

    expect(await screen.findByTestId('navigate-/onboarding')).toBeInTheDocument();
  });

  it('opens the requested page once the restore has been seen', async () => {
    appContext.user = { hasCompletedOnboarding: true };
    getRehydrateStatus.mockResolvedValue(status({ completed: true }));

    render(<AuthenticatedRoute />);

    expect(await screen.findByTestId('outlet')).toBeInTheDocument();
  });
});

/*
 * The desktop app's sign-in page names the account it was signed in as once that session ends some
 * other way, such as a password change. Nothing wrote that account in the desktop app (#2549).
 */
describe('AuthenticatedRoute remembers the desktop account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    getRehydrateStatus.mockResolvedValue(status({ completed: true }));
    appContext.user = { hasCompletedOnboarding: true, username: 'you@example.com' };
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('keeps the signed-in account in the desktop window', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: vi.fn() };

    render(<AuthenticatedRoute />);

    expect(await screen.findByTestId('outlet')).toBeInTheDocument();
    expect(localStorage.getItem('ci-hub.portalAccountEmail')).toBe('you@example.com');
  });

  // A browser can be shared: its sign-in page must not name whoever used it last.
  it('keeps nothing in a browser', async () => {
    render(<AuthenticatedRoute />);

    expect(await screen.findByTestId('outlet')).toBeInTheDocument();
    expect(localStorage.getItem('ci-hub.portalAccountEmail')).toBeNull();
  });
});
