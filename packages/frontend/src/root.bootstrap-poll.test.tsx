import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from './tests/test-utils';

// `/` waits on the root loader to send the page on, asking it again every 1.5 s. A new revalidation
// aborts the one in flight, so when each loader run took longer than that (a Hub reached from far
// away, through its public address), every run was cancelled before its redirect landed.

const router = vi.hoisted(() => ({
  revalidate: vi.fn(),
  revalidationState: 'idle' as 'idle' | 'loading',
  navigationState: 'idle' as 'idle' | 'loading' | 'submitting',
  pathname: '/',
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useRevalidator: () => ({ revalidate: router.revalidate, state: router.revalidationState }),
    useNavigation: () => ({ state: router.navigationState }),
    useLocation: () => ({ pathname: router.pathname, search: '', hash: '', state: null, key: 'default' }),
  };
});

vi.mock('./lib/mobile-connection', () => ({
  isTauriMobileSync: vi.fn(() => false),
  isMobileClient: vi.fn(() => false),
  usesCloudConnect: () => false,
  getHubBaseUrlSync: vi.fn(() => null),
  needsRemoteHubConnect: () => false,
  isCloudConnectPath: (pathname: string) => pathname === '/connect' || pathname.startsWith('/connect/'),
  initMobileConnection: vi.fn(async () => ({ isMobile: false, hubBaseUrl: null })),
  clearHubConnection: vi.fn(async () => {}),
}));

vi.mock('./lib/sentry', () => ({
  captureHubException: vi.fn(),
  loadHubSentryDeviceId: vi.fn(),
}));

vi.mock('./lib/api-fetch', () => ({
  getTauriSessionId: vi.fn(() => null),
  clearStaleServerSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./lib/registration-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/registration-cache')>();
  return { ...actual, resolveRegistrationStatus: vi.fn(), getCachedRegistrationStatus: vi.fn(() => null) };
});

vi.mock('./lib/hub-session-refresh', () => ({
  refreshHubSessionIfDue: vi.fn().mockResolvedValue(false),
  setServerSessionRefreshRecommendedAt: vi.fn(),
}));

vi.mock('./api-client', () => ({ userContext: vi.fn() }));

vi.mock('./api-client/client.gen', () => ({
  client: { interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } }, setConfig: vi.fn() },
}));

const { default: App, ROOT_BOOTSTRAP_POLL_MS, ROOT_BOOTSTRAP_RUN_LIMIT_MS } = await import('./root');

type AppProps = Parameters<typeof App>[0];
const renderApp = () => render(<App {...({ loaderData: null } as unknown as AppProps)} />);

describe('root bootstrap poll at /', () => {
  beforeEach(() => {
    // The page's toaster reads the colour scheme, which jsdom does not provide.
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    vi.useFakeTimers();
    router.revalidate.mockReset();
    router.revalidationState = 'idle';
    router.navigationState = 'idle';
    router.pathname = '/';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the root loader again on every tick while nothing is in flight', async () => {
    renderApp();
    expect(router.revalidate).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(ROOT_BOOTSTRAP_POLL_MS * 3);
    });
    expect(router.revalidate).toHaveBeenCalledTimes(4);
  });

  it('does not cancel a loader run that is still within the time a run can take', async () => {
    const { rerender } = renderApp();
    expect(router.revalidate).toHaveBeenCalledTimes(1);

    // The first revalidation is now in flight and slow, as it is through a far-away tunnel.
    router.revalidationState = 'loading';
    rerender(<App {...({ loaderData: null } as unknown as AppProps)} />);

    await act(async () => {
      vi.advanceTimersByTime(ROOT_BOOTSTRAP_RUN_LIMIT_MS - ROOT_BOOTSTRAP_POLL_MS);
    });
    expect(router.revalidate).toHaveBeenCalledTimes(1);
  });

  it('waits for a redirect navigation the loader started instead of restarting it', async () => {
    const { rerender } = renderApp();
    router.navigationState = 'loading';
    rerender(<App {...({ loaderData: null } as unknown as AppProps)} />);

    await act(async () => {
      vi.advanceTimersByTime(ROOT_BOOTSTRAP_POLL_MS * 6);
    });
    expect(router.revalidate).toHaveBeenCalledTimes(1);
  });

  it('replaces a loader run that has outlived any real run, so a hung request cannot hold the page', async () => {
    const { rerender } = renderApp();
    router.revalidationState = 'loading';
    rerender(<App {...({ loaderData: null } as unknown as AppProps)} />);

    await act(async () => {
      vi.advanceTimersByTime(ROOT_BOOTSTRAP_RUN_LIMIT_MS + ROOT_BOOTSTRAP_POLL_MS);
    });
    expect(router.revalidate).toHaveBeenCalledTimes(2);
  });

  it('gives the run that replaced a hung one its own time instead of cancelling it on the next tick', async () => {
    const { rerender } = renderApp();
    router.revalidationState = 'loading';
    rerender(<App {...({ loaderData: null } as unknown as AppProps)} />);

    // The router stays busy throughout: the replacement run is slow too.
    await act(async () => {
      vi.advanceTimersByTime(2 * ROOT_BOOTSTRAP_RUN_LIMIT_MS);
    });
    expect(router.revalidate).toHaveBeenCalledTimes(2);
  });

  it('gives the redirect navigation a run starts its own time', async () => {
    const { rerender } = renderApp();
    router.revalidationState = 'loading';
    rerender(<App {...({ loaderData: null } as unknown as AppProps)} />);
    await act(async () => {
      vi.advanceTimersByTime(ROOT_BOOTSTRAP_RUN_LIMIT_MS - 5_000);
    });

    // The run returned its redirect to /login, whose navigation runs the root loader again.
    router.navigationState = 'loading';
    rerender(<App {...({ loaderData: null } as unknown as AppProps)} />);
    await act(async () => {
      vi.advanceTimersByTime(ROOT_BOOTSTRAP_RUN_LIMIT_MS - ROOT_BOOTSTRAP_POLL_MS);
    });
    expect(router.revalidate).toHaveBeenCalledTimes(1);
  });

  it('polls again once the run in flight has finished', async () => {
    const { rerender } = renderApp();
    router.revalidationState = 'loading';
    rerender(<App {...({ loaderData: null } as unknown as AppProps)} />);
    await act(async () => {
      vi.advanceTimersByTime(ROOT_BOOTSTRAP_POLL_MS * 2);
    });
    expect(router.revalidate).toHaveBeenCalledTimes(1);

    router.revalidationState = 'idle';
    rerender(<App {...({ loaderData: null } as unknown as AppProps)} />);
    await act(async () => {
      vi.advanceTimersByTime(ROOT_BOOTSTRAP_POLL_MS);
    });
    expect(router.revalidate).toHaveBeenCalledTimes(2);
  });
});
