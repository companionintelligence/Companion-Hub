import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useQuery, useUserContext, useNavigate, searchParams, buildAppAccessPoints, appResult, contextResult } = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useUserContext: vi.fn(),
  useNavigate: vi.fn(),
  searchParams: { current: new URLSearchParams() },
  buildAppAccessPoints: vi.fn(),
  appResult: { current: {} as Record<string, unknown> },
  contextResult: { current: {} as Record<string, unknown> },
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

// The page runs three queries; dispatch on the (mocked) option factories' keys.
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: readonly unknown[] }) => useQuery(options),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getAppOptions: () => ({ queryKey: ['getApp'] }),
  appContextOptions: () => ({ queryKey: ['appContext'] }),
  getServeStatusOptions: () => ({ queryKey: ['getServeStatus'] }),
}));

vi.mock('@/context/user-context', () => ({
  useUserContext,
}));

// The access-point builder pulls in the whole app-details component graph; the
// page only needs its {url, state} output, and resolveSafeTarget's own origin
// matrix is covered by the pure-function tests below.
vi.mock('@/modules/app/components/app-access-points/app-access-points', () => ({
  buildAppAccessPoints,
  buildTailscaleServedPortSet: (entries: Array<{ listenPort?: number }>) => new Set(entries.map((entry) => entry.listenPort)),
}));

vi.mock('@/components/app-logo/app-logo', () => ({
  AppLogo: ({ urn }: { urn?: string }) => <div data-testid="app-logo" data-urn={urn} />,
}));

vi.mock('@/components/ui/LoadingSpinner/loading-spinner', () => ({
  PageLoadingSpinner: () => <div data-testid="page-loading" />,
}));

import MemoryConnectFinishingPage, { derivePhase, isTerminalSnapshot, resolveSafeTarget } from './memory-connect-finishing-page';

const APP_URN = 'ci-hermes:ci-marketplace';
const APP_URL = 'https://ci-hermes-hub-studio-companion.example.org/';

const CTX = {
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
};

const appData = (status: string) => ({
  data: {
    app: { status },
    info: { urn: APP_URN, name: 'Hermes' },
  },
  failureCount: 0,
});

const setParams = (params: Record<string, string>) => {
  searchParams.current = new URLSearchParams(params);
};

describe('MemoryConnectFinishingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('location', { ...window.location, origin: 'https://hub.example.org', assign: vi.fn(), replace: vi.fn() });
    useUserContext.mockReturnValue({ isLoggedIn: true, isLoading: false });
    buildAppAccessPoints.mockReturnValue([{ key: 'public', url: APP_URL, state: 'active' }]);
    setParams({ app: APP_URN, next: APP_URL });
    appResult.current = appData('restarting');
    contextResult.current = { data: CTX };
    useQuery.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
      const key = options.queryKey?.[0];
      if (key === 'appContext') return contextResult.current;
      if (key === 'getServeStatus') return { data: undefined };
      return appResult.current;
    });
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
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it('opens the validated next URL (history-replacing) after the grace beat once the app is running', () => {
    vi.useFakeTimers();
    appResult.current = appData('running');

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_READY')).toBeInTheDocument();
    expect(window.location.replace).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    // replace, not assign: Back from the app must not re-enter the interstitial.
    expect(window.location.replace).toHaveBeenCalledWith(APP_URL);
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('falls back to the derived app URL when next points at a foreign origin', () => {
    vi.useFakeTimers();
    appResult.current = appData('running');
    setParams({ app: APP_URN, next: 'https://evil.example.com/phish' });

    render(<MemoryConnectFinishingPage />);

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(window.location.replace).toHaveBeenCalledWith(APP_URL);
  });

  it('never navigates to a javascript: next', () => {
    vi.useFakeTimers();
    appResult.current = appData('running');
    setParams({ app: APP_URN, next: 'javascript:alert(1)' });

    render(<MemoryConnectFinishingPage />);

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(window.location.replace).toHaveBeenCalledWith(APP_URL);
  });

  it('shows the error card with both actions when the app ends up stopped', () => {
    appResult.current = appData('stopped');

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_TITLE')).toBeInTheDocument();
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_DESC')).toBeInTheDocument();

    fireEvent.click(screen.getByText('APP_ACTION_OPEN_ANYWAY'));
    expect(window.location.assign).toHaveBeenCalledWith(APP_URL);

    fireEvent.click(screen.getByText('MEMORY_CONNECT_FINISHING_BACK_TO_DASHBOARD'));
    expect(useNavigate).toHaveBeenCalledWith('/home');
  });

  it('keeps the definitive error copy when the timeout fires later (no downgrade to "taking longer")', () => {
    vi.useFakeTimers();
    appResult.current = appData('stopped');

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_DESC')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(180_000);
    });

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_DESC')).toBeInTheDocument();
    expect(screen.queryByText('MEMORY_CONNECT_FINISHING_TIMEOUT_DESC')).not.toBeInTheDocument();
  });

  it('uses nameless generic copy when the app row is gone — never interpolates the raw ?app= text', () => {
    appResult.current = { data: { app: null, info: undefined }, failureCount: 0 };
    buildAppAccessPoints.mockReturnValue([]);
    setParams({ app: 'YourBankAccount:x' });

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_TITLE')).toBeInTheDocument();
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_DESC_GENERIC')).toBeInTheDocument();
    expect(screen.queryByText('APP_ACTION_OPEN_ANYWAY')).not.toBeInTheDocument();
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_BACK_TO_DASHBOARD')).toBeInTheDocument();
  });

  it('keeps the connecting spinner through a transient fetch blip (below the failure limit)', () => {
    appResult.current = { data: undefined, failureCount: 1 };

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_TITLE')).toBeInTheDocument();
    expect(screen.queryByText('MEMORY_CONNECT_FINISHING_ERROR_TITLE')).not.toBeInTheDocument();
  });

  it('shows the error card once fetch failures settle (at the failure limit)', () => {
    appResult.current = { data: undefined, failureCount: 3 };

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_TITLE')).toBeInTheDocument();
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_DESC_GENERIC')).toBeInTheDocument();
  });

  it('times out into the error card when the restart never completes', () => {
    vi.useFakeTimers();
    appResult.current = appData('restarting');

    render(<MemoryConnectFinishingPage />);

    act(() => {
      vi.advanceTimersByTime(180_000);
    });

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_TIMEOUT_DESC')).toBeInTheDocument();
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it('shows the done copy (no false "Opening…") when running but no target is derivable', () => {
    vi.useFakeTimers();
    appResult.current = appData('running');
    buildAppAccessPoints.mockReturnValue([]);
    setParams({ app: APP_URN });

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_READY_DONE')).toBeInTheDocument();
    expect(screen.queryByText('MEMORY_CONNECT_FINISHING_READY')).not.toBeInTheDocument();
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_BACK_TO_DASHBOARD')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it('never navigates while the app-context data is unavailable (allowlist would be empty)', () => {
    vi.useFakeTimers();
    appResult.current = appData('running');
    contextResult.current = { data: undefined };

    render(<MemoryConnectFinishingPage />);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(window.location.replace).not.toHaveBeenCalled();
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_READY_DONE')).toBeInTheDocument();
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

  it('returns null when no access point is ACTIVE — never auto-navigates to a derivable-but-dead URL', () => {
    // 'available'/'unavailable' points carry a derived url that may have no
    // tunnel/DNS route behind it; falling back to one would land on a 404/530.
    expect(resolveSafeTarget(null, [{ url: 'https://only.example.org/', state: 'available' }], origin)).toBeNull();
    expect(resolveSafeTarget(null, [{ url: 'https://dead.example.org/', state: 'unavailable' }], origin)).toBeNull();
    expect(resolveSafeTarget(null, [], origin)).toBeNull();
  });
});

describe('phase and terminal derivation', () => {
  const snapshot = (status: string) => ({ app: { status } }) as Parameters<typeof derivePhase>[0];

  it('ready wins over timeout — a late recovery still self-resolves', () => {
    expect(derivePhase(snapshot('running'), 0, true)).toBe('ready');
  });

  it('a definitive failure wins over timeout — the message never downgrades', () => {
    expect(derivePhase(snapshot('stopped'), 0, true)).toBe('error');
    expect(derivePhase({ app: null }, 0, true)).toBe('error');
  });

  it('a transient blip keeps connecting; settled failure is an error', () => {
    expect(derivePhase(undefined, 1, false)).toBe('connecting');
    expect(derivePhase(undefined, 3, false)).toBe('error');
  });

  it('timeout applies only while indeterminate', () => {
    expect(derivePhase(snapshot('restarting'), 0, true)).toBe('timeout');
    expect(derivePhase(snapshot('restarting'), 0, false)).toBe('connecting');
  });

  it('terminal matches the phases that stop the poll, including settled failure', () => {
    expect(isTerminalSnapshot(snapshot('running'), 0)).toBe(true);
    expect(isTerminalSnapshot({ app: null }, 0)).toBe(true);
    expect(isTerminalSnapshot(snapshot('stopped'), 0)).toBe(true);
    expect(isTerminalSnapshot(snapshot('restarting'), 0)).toBe(false);
    expect(isTerminalSnapshot(undefined, 1)).toBe(false);
    expect(isTerminalSnapshot(undefined, 3)).toBe(true);
  });
});
