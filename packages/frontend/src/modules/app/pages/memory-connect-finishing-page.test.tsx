import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useQuery, useUserContext, useNavigate, searchParams, buildAppAccessPoints, appResult, contextResult, availabilityResult } = vi.hoisted(
  () => ({
    useQuery: vi.fn(),
    useUserContext: vi.fn(),
    useNavigate: vi.fn(),
    searchParams: { current: new URLSearchParams() },
    buildAppAccessPoints: vi.fn(),
    appResult: { current: {} as Record<string, unknown> },
    contextResult: { current: {} as Record<string, unknown> },
    availabilityResult: { current: {} as Record<string, unknown> },
  }),
);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  // The named copy renders through <Trans>; stub it to its key so the
  // getByText(KEY) assertions below keep matching (mirrors the t() stub).
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
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
  checkAvailabilityOptions: () => ({ queryKey: ['checkAvailability'] }),
}));

vi.mock('@/context/user-context', () => ({
  useUserContext,
}));

// The access-point builder pulls in the whole app-details component graph; the
// page only needs its {url, state} output, and resolveSafeTarget's own origin
// matrix is covered by the pure-function tests below. The served-port stub
// mirrors the real helper's number-only filter so it can't drift into admitting
// undefined ports.
vi.mock('@/modules/app/components/app-access-points/app-access-points', () => ({
  buildAppAccessPoints,
  buildTailscaleServedPortSet: (entries: Array<{ listenPort?: number }>) =>
    new Set(entries.map((entry) => entry.listenPort).filter((port): port is number => typeof port === 'number')),
}));

vi.mock('@/components/app-logo/app-logo', () => ({
  AppLogo: ({ urn }: { urn?: string }) => <div data-testid="app-logo" data-urn={urn} />,
}));

vi.mock('@/components/ui/LoadingSpinner/loading-spinner', () => ({
  PageLoadingSpinner: () => <div data-testid="page-loading" />,
}));

import MemoryConnectFinishingPage, { derivePhase, isCrossOriginTarget, isPollSettled, resolveSafeTarget } from './memory-connect-finishing-page';

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
    // Default: the public URL answers immediately, so the hop is not held.
    availabilityResult.current = { data: { available: true, stage: 'ready' }, isError: false };
    useQuery.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
      const key = options.queryKey?.[0];
      if (key === 'appContext') return contextResult.current;
      if (key === 'getServeStatus') return { data: undefined };
      if (key === 'checkAvailability') return availabilityResult.current;
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

  it('keeps the connecting spinner through a transient fetch blip (no data yet)', () => {
    // React Query keeps the last snapshot on a failed refetch; with none yet the
    // page must stay on the connecting spinner rather than flashing a false error.
    appResult.current = { data: undefined };

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_TITLE')).toBeInTheDocument();
    expect(screen.queryByText('MEMORY_CONNECT_FINISHING_ERROR_TITLE')).not.toBeInTheDocument();
  });

  it('recovers and forwards when a transient down status later flips back to running', () => {
    // A slow restart can momentarily report 'stopped' (e.g. a queue RPC timeout
    // mid-compose); the poll must keep going so the later recovery still hops.
    vi.useFakeTimers();
    appResult.current = appData('stopped');

    const { rerender } = render(<MemoryConnectFinishingPage />);
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_ERROR_TITLE')).toBeInTheDocument();

    appResult.current = appData('running');
    rerender(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_READY')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(window.location.replace).toHaveBeenCalledWith(APP_URL);
  });

  it('holds on the propagating card (no navigation) while the public URL does not answer yet', () => {
    vi.useFakeTimers();
    appResult.current = appData('running');
    availabilityResult.current = { data: { available: false, stage: 'propagating' }, isError: false };

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_PROPAGATING_TITLE')).toBeInTheDocument();
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_PROPAGATING_DESC')).toBeInTheDocument();
    // The escape hatch to the Hub is available while the user waits.
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_BACK_TO_DASHBOARD')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it('forwards once the probe flips to available', () => {
    vi.useFakeTimers();
    appResult.current = appData('running');
    availabilityResult.current = { data: { available: false, stage: 'propagating' }, isError: false };

    const { rerender } = render(<MemoryConnectFinishingPage />);
    expect(screen.getByText('MEMORY_CONNECT_FINISHING_PROPAGATING_TITLE')).toBeInTheDocument();

    availabilityResult.current = { data: { available: true, stage: 'ready' }, isError: false };
    rerender(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_READY')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(window.location.replace).toHaveBeenCalledWith(APP_URL);
  });

  it('lapses into the timeout card with propagation copy (and Open anyway) when the URL never answers', () => {
    vi.useFakeTimers();
    appResult.current = appData('running');
    availabilityResult.current = { data: { available: false, stage: 'propagating' }, isError: false };

    render(<MemoryConnectFinishingPage />);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_PROPAGATING_TIMEOUT_DESC')).toBeInTheDocument();
    expect(window.location.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('APP_ACTION_OPEN_ANYWAY'));
    expect(window.location.assign).toHaveBeenCalledWith(APP_URL);
  });

  it('fails open when the probe endpoint itself errors — the hop must not be stranded by a broken probe', () => {
    vi.useFakeTimers();
    appResult.current = appData('running');
    availabilityResult.current = { data: undefined, isError: true };

    render(<MemoryConnectFinishingPage />);

    expect(screen.getByText('MEMORY_CONNECT_FINISHING_READY')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(window.location.replace).toHaveBeenCalledWith(APP_URL);
  });

  it('skips the reachability gate for a same-origin next (nothing to propagate)', () => {
    vi.useFakeTimers();
    appResult.current = appData('running');
    availabilityResult.current = { data: { available: false, stage: 'propagating' }, isError: false };
    setParams({ app: APP_URN, next: 'https://hub.example.org/apps/ci-hermes' });

    render(<MemoryConnectFinishingPage />);

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(window.location.replace).toHaveBeenCalledWith('https://hub.example.org/apps/ci-hermes');
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

describe('isCrossOriginTarget', () => {
  const origin = 'https://hub.example.org';

  it('gates only when the target leaves the current origin', () => {
    expect(isCrossOriginTarget('https://app.example.org/', origin)).toBe(true);
    expect(isCrossOriginTarget('https://hub.example.org/apps/x', origin)).toBe(false);
    expect(isCrossOriginTarget('/apps/x', origin)).toBe(false);
  });

  it('never gates on a missing or unparseable target', () => {
    expect(isCrossOriginTarget(null, origin)).toBe(false);
    expect(isCrossOriginTarget('http://', origin)).toBe(false);
  });
});

describe('phase and poll-settled derivation', () => {
  const snapshot = (status: string) => ({ app: { status } }) as Parameters<typeof derivePhase>[0];

  it('ready wins over timeout — a late recovery still self-resolves', () => {
    expect(derivePhase(snapshot('running'), true)).toBe('ready');
  });

  it('a definitive failure wins over timeout — the message never downgrades', () => {
    expect(derivePhase(snapshot('stopped'), true)).toBe('error');
    expect(derivePhase({ app: null }, true)).toBe('error');
  });

  it('a fetch blip (no/last snapshot) keeps connecting rather than flashing an error', () => {
    expect(derivePhase(undefined, false)).toBe('connecting');
  });

  it('timeout applies only while indeterminate', () => {
    expect(derivePhase(snapshot('restarting'), true)).toBe('timeout');
    expect(derivePhase(snapshot('restarting'), false)).toBe('connecting');
  });

  it('poll stops only on running or a vanished row — a down status keeps polling for recovery', () => {
    expect(isPollSettled(snapshot('running'))).toBe(true);
    expect(isPollSettled({ app: null })).toBe(true);
    // A down status is NOT settled: it may still recover, so keep polling.
    expect(isPollSettled(snapshot('stopped'))).toBe(false);
    expect(isPollSettled(snapshot('restarting'))).toBe(false);
    expect(isPollSettled(undefined)).toBe(false);
  });
});
