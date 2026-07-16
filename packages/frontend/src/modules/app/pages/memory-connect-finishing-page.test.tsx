import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useQuery, useUserContext, useNavigate, searchParams, buildAppAccessPoints } = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useUserContext: vi.fn(),
  useNavigate: vi.fn(),
  searchParams: { current: new URLSearchParams() },
  buildAppAccessPoints: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => useNavigate,
    useSearchParams: () => [searchParams.current],
    Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQuery,
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getAppOptions: () => ({ queryKey: ['app'] }),
}));

vi.mock('@/context/user-context', () => ({
  useUserContext,
}));

vi.mock('@/context/app-context', () => ({
  AppContextProvider: ({ children }: { children: React.ReactNode }) => children,
  useAppContext: () => ({
    isLoading: false,
    userSettings: {
      sslPort: 443,
      internalIp: '0.0.0.0',
      domain: 'example.org',
      ciHubOrganizationSlug: 'companion',
      ciHubDeviceSlug: 'studio',
      ciHubHubSubdomain: 'hub-studio-companion',
    },
    cloudflareAvailable: true,
    tailscaleAvailable: false,
    tailscaleNodeFqdn: null,
    tailscaleHttpsEnabled: false,
  }),
}));

// The access-point builder pulls in the whole app-details component graph; the
// page only needs its {url, state} output, and resolveSafeTarget's own origin
// matrix is covered by the pure-function tests below.
vi.mock('@/modules/app/components/app-access-points/app-access-points', () => ({
  buildAppAccessPoints,
}));

vi.mock('@/components/app-logo/app-logo', () => ({
  AppLogo: ({ urn }: { urn?: string }) => <div data-testid="app-logo" data-urn={urn} />,
}));

vi.mock('@/components/ui/LoadingSpinner/loading-spinner', () => ({
  PageLoadingSpinner: () => <div data-testid="page-loading" />,
}));

import MemoryConnectFinishingPage, { resolveSafeTarget } from './memory-connect-finishing-page';

const APP_URN = 'ci-hermes:ci-marketplace';
const APP_URL = 'https://ci-hermes-hub-studio-companion.example.org/';

const appData = (status: string) => ({
  data: {
    app: { status },
    info: { urn: APP_URN, name: 'Hermes' },
  },
  isError: false,
});

const setParams = (params: Record<string, string>) => {
  searchParams.current = new URLSearchParams(params);
};

describe('MemoryConnectFinishingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('location', { ...window.location, origin: 'https://hub.example.org', assign: vi.fn() });
    useUserContext.mockReturnValue({ isLoggedIn: true, isLoading: false });
    buildAppAccessPoints.mockReturnValue([{ key: 'public', url: APP_URL, state: 'active' }]);
    setParams({ app: APP_URN, next: APP_URL });
    useQuery.mockReturnValue(appData('restarting'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows the connecting card (logo pair + spinner) while the app restarts', () => {
    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_TITLE')).toBeInTheDocument();
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_DESC')).toBeInTheDocument();
    const logos = screen.getAllByTestId('app-logo');
    expect(logos.map((logo) => logo.dataset.urn)).toEqual([APP_URN, 'ci-memory:ci-marketplace']);
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('opens the validated next URL after the grace beat once the app is running', () => {
    vi.useFakeTimers();
    useQuery.mockReturnValue(appData('running'));

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_READY')).toBeInTheDocument();
    expect(window.location.assign).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(window.location.assign).toHaveBeenCalledWith(APP_URL);
  });

  it('falls back to the derived app URL when next points at a foreign origin', () => {
    vi.useFakeTimers();
    useQuery.mockReturnValue(appData('running'));
    setParams({ app: APP_URN, next: 'https://evil.example.com/phish' });

    render(<MemoryConnectFinishingPage />);

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(window.location.assign).toHaveBeenCalledWith(APP_URL);
  });

  it('never navigates to a javascript: next', () => {
    vi.useFakeTimers();
    useQuery.mockReturnValue(appData('running'));
    setParams({ app: APP_URN, next: 'javascript:alert(1)' });

    render(<MemoryConnectFinishingPage />);

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(window.location.assign).toHaveBeenCalledWith(APP_URL);
  });

  it('shows the error card with both actions when the app ends up stopped', () => {
    useQuery.mockReturnValue(appData('stopped'));

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_TITLE')).toBeInTheDocument();
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_DESC')).toBeInTheDocument();

    fireEvent.click(screen.getByText('MEMORY_CONNECT_FINISHING_OPEN_ANYWAY'));
    expect(window.location.assign).toHaveBeenCalledWith(APP_URL);

    fireEvent.click(screen.getByText('MEMORY_CONNECT_FINISHING_BACK_TO_DASHBOARD'));
    expect(useNavigate).toHaveBeenCalledWith('/home');
  });

  it('omits "open anyway" when the app row is gone and no target is derivable', () => {
    useQuery.mockReturnValue({ data: { app: null, info: undefined }, isError: false });
    buildAppAccessPoints.mockReturnValue([]);
    setParams({ app: APP_URN });

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_TITLE')).toBeInTheDocument();
    expect(screen.queryByText('MEMORY_CONNECT_FINISHING_OPEN_ANYWAY')).not.toBeInTheDocument();
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_BACK_TO_DASHBOARD')).toBeInTheDocument();
  });

  it('times out into the error card when the restart never completes', () => {
    vi.useFakeTimers();
    useQuery.mockReturnValue(appData('restarting'));

    render(<MemoryConnectFinishingPage />);

    act(() => {
      vi.advanceTimersByTime(180_000);
    });

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_TIMEOUT_DESC')).toBeInTheDocument();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('shows the page loader while the session is still resolving', () => {
    useUserContext.mockReturnValue({ isLoggedIn: false, isLoading: true });

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByTestId('page-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('navigate')).not.toBeInTheDocument();
  });

  it('bounces an unauthenticated session to /login', () => {
    useUserContext.mockReturnValue({ isLoggedIn: false, isLoading: false });

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByTestId('navigate').dataset.to).toBe('/login');
  });

  it('bounces to /home when the app param is missing', () => {
    setParams({});

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByTestId('navigate').dataset.to).toBe('/home');
  });
});

describe('resolveSafeTarget', () => {
  const points = [
    { url: 'https://app.example.org/', state: 'active' },
    { url: 'https://node.ts.net:8443/', state: 'available' },
  ];
  const origin = 'https://hub.example.org';

  it('honors next on an allowed app origin', () => {
    expect(resolveSafeTarget('https://app.example.org/deep/link', points, origin)).toBe('https://app.example.org/deep/link');
  });

  it('honors next on the Hub origin, including relative paths', () => {
    expect(resolveSafeTarget('https://hub.example.org/home', points, origin)).toBe('https://hub.example.org/home');
    expect(resolveSafeTarget('/home', points, origin)).toBe('https://hub.example.org/home');
  });

  it('rejects a foreign origin and falls back to the active access point', () => {
    expect(resolveSafeTarget('https://evil.example.com/', points, origin)).toBe('https://app.example.org/');
  });

  it('rejects non-http(s) schemes', () => {
    expect(resolveSafeTarget('javascript:alert(1)', points, origin)).toBe('https://app.example.org/');
  });

  it('prefers an active access point over an earlier inactive one for the fallback', () => {
    const shuffled = [
      { url: 'https://inactive.example.org/', state: 'unavailable' },
      { url: 'https://active.example.org/', state: 'active' },
    ];

    expect(resolveSafeTarget(null, shuffled, origin)).toBe('https://active.example.org/');
  });

  it('falls back to the first URL when nothing is active, and null when there is nothing at all', () => {
    expect(resolveSafeTarget(null, [{ url: 'https://only.example.org/', state: 'available' }], origin)).toBe('https://only.example.org/');
    expect(resolveSafeTarget(null, [], origin)).toBeNull();
  });
});
