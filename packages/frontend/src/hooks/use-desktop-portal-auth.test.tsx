import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@/tests/test-utils';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const toastMock = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: { error: (...a: unknown[]) => toastMock.error(...a) } }));

const ctx = vi.hoisted(() => ({ setUserContext: vi.fn() }));
vi.mock('@/context/user-context', () => ({ useUserContext: () => ctx }));

const api = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  setTauriSessionId: vi.fn(),
  markHubSessionIssuedAt: vi.fn(),
}));
vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...a: unknown[]) => api.apiFetch(...a),
  setTauriSessionId: (...a: unknown[]) => api.setTauriSessionId(...a),
  markHubSessionIssuedAt: (...a: unknown[]) => api.markHubSessionIssuedAt(...a),
}));

vi.mock('@/api-client/client.gen', () => ({
  client: {
    setConfig: vi.fn(),
    getConfig: vi.fn(() => ({ baseUrl: '', credentials: 'include' })),
  },
}));

const runtime = vi.hoisted(() => ({
  getTauriInvoke: vi.fn((): object | null => ({})),
  isTauriDesktopApp: vi.fn(() => true),
  isMobileClient: vi.fn(() => false),
  getHubBaseUrlSync: vi.fn(() => null as string | null),
}));
vi.mock('@/lib/helpers/tauri-invoke', () => ({ getTauriInvoke: () => runtime.getTauriInvoke() }));
vi.mock('@/lib/hub-runtime-mode', () => ({ isTauriDesktopApp: () => runtime.isTauriDesktopApp() }));
vi.mock('@/lib/mobile-connection', () => ({
  isMobileClient: () => runtime.isMobileClient(),
  usesCloudConnect: () => runtime.isMobileClient(),
  getHubBaseUrlSync: () => runtime.getHubBaseUrlSync(),
}));
vi.mock('@/lib/portal-sso-url', () => ({
  buildPortalDesktopExchangeUrl: ({ token }: { token: string }) =>
    `http://localhost:5005/api/auth/portal/desktop-exchange?token=${encodeURIComponent(token)}`,
}));

vi.mock('@/lib/tauri-hub-probe', () => ({ isViteLocalFrontend: () => true }));

const dl = vi.hoisted(() => ({
  takePendingDesktopPortalAuth: vi.fn(),
  persistDesktopPortalToken: vi.fn(),
  takePersistedDesktopPortalToken: vi.fn(),
  clearPersistedDesktopPortalToken: vi.fn(),
}));
vi.mock('@/lib/deep-link-auth', () => ({
  takePendingDesktopPortalAuth: () => dl.takePendingDesktopPortalAuth(),
  persistDesktopPortalToken: (...a: unknown[]) => dl.persistDesktopPortalToken(...a),
  takePersistedDesktopPortalToken: () => dl.takePersistedDesktopPortalToken(),
  clearPersistedDesktopPortalToken: () => dl.clearPersistedDesktopPortalToken(),
}));

const hint = vi.hoisted(() => ({ rememberPortalAccountEmail: vi.fn(), resolvePortalSessionHint: vi.fn() }));
vi.mock('@/lib/portal-session-hint', () => ({
  rememberPortalAccountEmail: (...a: unknown[]) => hint.rememberPortalAccountEmail(...a),
  resolvePortalSessionHint: () => hint.resolvePortalSessionHint(),
}));

const locationAssign = vi.hoisted(() => vi.fn());

const ev = vi.hoisted(() => ({
  handler: null as ((e: { payload: unknown }) => void) | null,
  unlisten: vi.fn(),
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    ev.listen(name);
    ev.handler = cb;
    return ev.unlisten;
  },
}));

const { useDesktopPortalAuth } = await import('./use-desktop-portal-auth');

beforeEach(() => {
  runtime.getTauriInvoke.mockReturnValue({});
  runtime.isTauriDesktopApp.mockReturnValue(true);
  runtime.isMobileClient.mockReturnValue(false);
  runtime.getHubBaseUrlSync.mockReturnValue(null);
  ev.handler = null;
  locationAssign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...window.location,
      origin: 'http://localhost:5005',
      port: '5005',
      assign: locationAssign,
    },
  });
  api.apiFetch.mockClear();
  api.apiFetch.mockImplementation(async (_path: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ sessionId: 'sess-1', redirectPath: '/dashboard' }),
  }));
  for (const m of [
    locationAssign,
    toastMock.error,
    ev.unlisten,
    ev.listen,
    api.setTauriSessionId,
    api.markHubSessionIssuedAt,
    hint.rememberPortalAccountEmail,
  ]) {
    m.mockClear();
  }
  ctx.setUserContext.mockReset();
  dl.takePendingDesktopPortalAuth.mockReset().mockResolvedValue(null);
  dl.persistDesktopPortalToken.mockReset();
  dl.takePersistedDesktopPortalToken.mockReset().mockReturnValue(null);
  dl.clearPersistedDesktopPortalToken.mockReset();
  hint.resolvePortalSessionHint.mockReset().mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDesktopPortalAuth — wiring', () => {
  it('is inert outside the Tauri shell (plain web build never exchanges)', async () => {
    runtime.getTauriInvoke.mockReturnValue(null);
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(dl.takePendingDesktopPortalAuth).not.toHaveBeenCalled());
    expect(ev.listen).not.toHaveBeenCalled();
    expect(api.apiFetch).not.toHaveBeenCalled();
  });

  it('tells the Hub this desktop window is running so browser callbacks can hand off', async () => {
    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => {
      expect(api.apiFetch).toHaveBeenCalledWith('/api/auth/portal/session-hint?desktop=1');
    });
  });

  it('does not heartbeat desktop presence on iOS/Android (remote Hub owns the callback)', async () => {
    runtime.isTauriDesktopApp.mockReturnValue(false);
    runtime.isMobileClient.mockReturnValue(true);
    runtime.getHubBaseUrlSync.mockReturnValue('https://hub.example.com');

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(ev.listen).toHaveBeenCalled());
    expect(api.apiFetch).not.toHaveBeenCalledWith('/api/auth/portal/session-hint?desktop=1');
  });

  it('subscribes to deep-link-auth', async () => {
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(ev.listen).toHaveBeenCalledWith('deep-link-auth'));
  });

  it('does not listen for Hub token handoff during iOS/Android cloud-connect PKCE', async () => {
    runtime.isTauriDesktopApp.mockReturnValue(false);
    runtime.isMobileClient.mockReturnValue(true);
    runtime.getHubBaseUrlSync.mockReturnValue(null);

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(dl.takePendingDesktopPortalAuth).not.toHaveBeenCalled());
    expect(ev.listen).not.toHaveBeenCalled();
  });
});

describe('useDesktopPortalAuth — successful handoff', () => {
  it('exchanges on the same Hub that issued the token (local:desktop)', async () => {
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-cold' });

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => {
      expect(api.apiFetch.mock.calls.some((call) => String(call[0]).includes('desktop-exchange'))).toBe(true);
    });
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(api.setTauriSessionId).toHaveBeenCalledWith('sess-1');
    expect(ctx.setUserContext).toHaveBeenCalledWith({ isLoggedIn: true });
  });

  it('exchanges on the remote Hub for iOS/Android /login, not local Vite', async () => {
    runtime.isTauriDesktopApp.mockReturnValue(false);
    runtime.isMobileClient.mockReturnValue(true);
    runtime.getHubBaseUrlSync.mockReturnValue('https://hub-core3-bc.companionintelligence.com');
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-mobile' });

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(api.setTauriSessionId).toHaveBeenCalledWith('sess-1'));
    expect(api.apiFetch).toHaveBeenCalledWith('/api/auth/portal/desktop-exchange?token=tok-mobile', expect.any(Object));
  });
});

describe('useDesktopPortalAuth — failure handling', () => {
  it('does not sign the user in when the exchange rejects', async () => {
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-throw' });
    api.apiFetch.mockRejectedValue(new Error('boom'));

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('COMMON_AN_ERROR_OCCURRED'));
    expect(api.setTauriSessionId).not.toHaveBeenCalled();
    expect(locationAssign).not.toHaveBeenCalled();
  });
});
