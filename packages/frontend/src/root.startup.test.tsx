import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from './tests/test-utils';

const { isTauriMobileSync, isMobileClient, getHubBaseUrlSync, initMobileConnection, clearHubConnection } = vi.hoisted(() => ({
  isTauriMobileSync: vi.fn(() => false),
  isMobileClient: vi.fn(() => false),
  getHubBaseUrlSync: vi.fn((): string | null => null),
  initMobileConnection: vi.fn(async () => ({ isMobile: false, hubBaseUrl: null })),
  clearHubConnection: vi.fn(async () => {}),
}));

vi.mock('./lib/mobile-connection', () => ({
  isTauriMobileSync,
  isMobileClient,
  usesCloudConnect: () => isMobileClient(),
  getHubBaseUrlSync,
  needsRemoteHubConnect: () => isMobileClient() && !getHubBaseUrlSync(),
  isCloudConnectPath: (pathname: string) => pathname === '/connect' || pathname.startsWith('/connect/'),
  initMobileConnection,
  clearHubConnection,
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
  return {
    ...actual,
    resolveRegistrationStatus: vi.fn(),
    getCachedRegistrationStatus: vi.fn(() => null),
  };
});

vi.mock('./lib/hub-session-refresh', () => ({
  refreshHubSessionIfDue: vi.fn().mockResolvedValue(false),
  setServerSessionRefreshRecommendedAt: vi.fn(),
}));

vi.mock('./api-client', () => ({
  userContext: vi.fn(),
}));

vi.mock('./api-client/client.gen', () => ({
  client: {
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    setConfig: vi.fn(),
  },
}));

const { DesktopStartupFallback } = await import('./root');

const DESKTOP_COPY = 'Connecting to local API...';

describe('root startup/loading fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMobileSync.mockReturnValue(false);
    isMobileClient.mockReturnValue(false);
    getHubBaseUrlSync.mockReturnValue(null);
  });

  it('sends a phone with no Hub to /connect instead of a second splash', () => {
    isMobileClient.mockReturnValue(true);
    const replace = vi.fn();
    vi.stubGlobal('location', { pathname: '/', replace, assign: vi.fn(), href: 'http://localhost:5005/' });

    render(<DesktopStartupFallback />);

    expect(replace).toHaveBeenCalledWith('/connect');
    expect(screen.queryByText('Connect to your Hub')).not.toBeInTheDocument();
    expect(screen.queryByText(DESKTOP_COPY)).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('sends a phone that already chose a Hub to /login', () => {
    isMobileClient.mockReturnValue(true);
    getHubBaseUrlSync.mockReturnValue('https://hub-apple.ci.computer');
    const replace = vi.fn();
    vi.stubGlobal('location', { pathname: '/', replace, assign: vi.fn(), href: 'http://localhost:5005/' });

    render(<DesktopStartupFallback />);

    expect(replace).toHaveBeenCalledWith('/login');
    vi.unstubAllGlobals();
  });

  it('does not bounce when already on /connect', () => {
    isMobileClient.mockReturnValue(true);
    const replace = vi.fn();
    vi.stubGlobal('location', { pathname: '/connect', replace, assign: vi.fn(), href: 'http://localhost:5005/connect' });

    render(<DesktopStartupFallback />);

    expect(replace).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shows the desktop local-API copy on desktop', () => {
    render(<DesktopStartupFallback />);

    expect(screen.getByText(DESKTOP_COPY)).toBeInTheDocument();
    expect(screen.queryByTestId('startup-switch-hub-btn')).not.toBeInTheDocument();
  });

  it('covers the viewport so a hydrated store cannot paint underneath it', () => {
    render(<DesktopStartupFallback />);

    const gate = screen.getByTestId('connecting-to-local-api');
    expect(gate).toHaveClass('fixed', 'inset-0');
    expect(gate.className).not.toMatch(/min-h-\[40vh\]/);
  });

  it('offers a reload after the connecting copy has been up for a few seconds', async () => {
    vi.useFakeTimers();
    render(<DesktopStartupFallback />);

    expect(screen.queryByRole('button', { name: /reload/i })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    vi.useRealTimers();
  });
});
