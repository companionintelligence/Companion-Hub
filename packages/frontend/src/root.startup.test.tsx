import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from './tests/test-utils';

// root.tsx runs module-load side effects (registers API-client interceptors,
// sets client config) and pulls in the Sentry/registration/session modules.
// Mirror the mocks in root.test.tsx so importing ./root is inert, and add a
// controllable mock for the mobile-connection detector — the startup fallback
// branches on isTauriMobileSync() to pick mobile vs. desktop "connecting" copy.
const { isTauriMobileSync, getHubBaseUrlSync, initMobileConnection, clearHubConnection } = vi.hoisted(() => ({
  isTauriMobileSync: vi.fn(() => false),
  getHubBaseUrlSync: vi.fn((): string | null => null),
  initMobileConnection: vi.fn(async () => ({ isMobile: false, hubBaseUrl: null })),
  clearHubConnection: vi.fn(async () => {}),
}));

vi.mock('./lib/mobile-connection', () => ({
  isTauriMobileSync,
  getHubBaseUrlSync,
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

// English copy (setup.ts initializes i18next with the real en.json bundle).
const MOBILE_COPY = 'Connecting…'; // ROOT_CONNECTING — note the single-char ellipsis
const DESKTOP_COPY = 'Connecting to local API...'; // ROOT_CONNECTING_TO_LOCAL_API

describe('root startup/loading fallback — mobile branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMobileSync.mockReturnValue(false);
  });

  it('shows the mobile "Connecting…" copy and NOT the desktop local-API copy on mobile', () => {
    isTauriMobileSync.mockReturnValue(true);

    render(<DesktopStartupFallback />);

    expect(screen.getByText(MOBILE_COPY)).toBeInTheDocument();
    // The desktop copy names a "local API" that a thin-client phone never has —
    // it must not leak onto the mobile loading screen.
    expect(screen.queryByText(DESKTOP_COPY)).not.toBeInTheDocument();
  });

  it('renders without throwing on mobile', () => {
    isTauriMobileSync.mockReturnValue(true);

    expect(() => render(<DesktopStartupFallback />)).not.toThrow();
  });

  it('applies the mobile safe-area / full-height layout classes', () => {
    isTauriMobileSync.mockReturnValue(true);

    render(<DesktopStartupFallback />);

    // role="status" + aria-busy keep it accessible while the app connects.
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    // safe-area-inset + min-h-dvh keep the loading screen clear of the notch/home
    // indicator and fill the dynamic viewport; bg-background matches the dark app.
    expect(region).toHaveClass('safe-area-inset', 'min-h-dvh', 'items-center', 'justify-center', 'bg-background');
  });

  it('shows the desktop local-API copy on desktop (branch differs from mobile)', () => {
    isTauriMobileSync.mockReturnValue(false);

    render(<DesktopStartupFallback />);

    expect(screen.getByText(DESKTOP_COPY)).toBeInTheDocument();
    expect(screen.queryByText(MOBILE_COPY)).not.toBeInTheDocument();
  });

  it('offers a Switch Hub escape hatch after 8s when a stored Hub is unreachable', async () => {
    isTauriMobileSync.mockReturnValue(true);
    getHubBaseUrlSync.mockReturnValue('https://hub-apple.ci.computer');
    vi.useFakeTimers();
    try {
      render(<DesktopStartupFallback />);
      // Not shown immediately — normal startups resolve well within the window.
      expect(screen.queryByTestId('startup-switch-hub-btn')).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(8000);
      });
      const btn = screen.getByTestId('startup-switch-hub-btn');
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);
    } finally {
      vi.useRealTimers();
    }
    // Clicking clears the stored connection (then hard-navigates to /connect —
    // jsdom logs "Not implemented: navigation", which is expected noise).
    await waitFor(() => expect(clearHubConnection).toHaveBeenCalledTimes(1));
  });

  it('never shows the escape hatch on first run (no stored Hub)', () => {
    isTauriMobileSync.mockReturnValue(true);
    getHubBaseUrlSync.mockReturnValue(null);
    vi.useFakeTimers();
    try {
      render(<DesktopStartupFallback />);
      act(() => {
        vi.advanceTimersByTime(20000);
      });
      expect(screen.queryByTestId('startup-switch-hub-btn')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('picks a different message for mobile vs. desktop', () => {
    isTauriMobileSync.mockReturnValue(true);
    const { unmount } = render(<DesktopStartupFallback />);
    const mobileText = screen.getByRole('status').textContent;
    unmount();

    isTauriMobileSync.mockReturnValue(false);
    render(<DesktopStartupFallback />);
    const desktopText = screen.getByRole('status').textContent;

    expect(mobileText).toBe(MOBILE_COPY);
    expect(desktopText).toBe(DESKTOP_COPY);
    expect(mobileText).not.toBe(desktopText);
  });
});
