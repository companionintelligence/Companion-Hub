import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@/tests/test-utils';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const toastMock = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastMock.error(...a) } }));

const ctx = vi.hoisted(() => ({ setUserContext: vi.fn(), isLoggedIn: false, isLoading: false }));
vi.mock('@/context/user-context', () => ({ useUserContext: () => ctx }));

const api = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  setTauriSessionId: vi.fn(),
  markHubSessionIssuedAt: vi.fn(),
  getHubSessionIssuedAt: vi.fn((): number | null => 1_000),
}));
vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...a: unknown[]) => api.apiFetch(...a),
  setTauriSessionId: (...a: unknown[]) => api.setTauriSessionId(...a),
  markHubSessionIssuedAt: (...a: unknown[]) => api.markHubSessionIssuedAt(...a),
  getHubSessionIssuedAt: () => api.getHubSessionIssuedAt(),
}));

vi.mock('@/api-client/client.gen', () => ({
  client: {
    setConfig: vi.fn(),
    getConfig: vi.fn(() => ({ baseUrl: '', credentials: 'include' })),
  },
}));

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => true));

const runtime = vi.hoisted(() => ({
  getTauriInvoke: vi.fn((): typeof invoke | null => invoke),
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
  used: new Set<string>(),
}));
vi.mock('@/lib/deep-link-auth', () => ({
  takePendingDesktopPortalAuth: () => dl.takePendingDesktopPortalAuth(),
  persistDesktopPortalToken: (...a: unknown[]) => dl.persistDesktopPortalToken(...a),
  takePersistedDesktopPortalToken: () => dl.takePersistedDesktopPortalToken(),
  clearPersistedDesktopPortalToken: () => dl.clearPersistedDesktopPortalToken(),
  rememberUsedDesktopPortalToken: (token: string) => dl.used.add(token),
  isUsedDesktopPortalToken: (token: string) => dl.used.has(token),
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
  invoke.mockReset().mockResolvedValue(true);
  runtime.getTauriInvoke.mockReturnValue(invoke);
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
      hostname: 'localhost',
      port: '5005',
      assign: locationAssign,
    },
  });
  api.apiFetch.mockClear();
  api.getHubSessionIssuedAt.mockReset().mockReturnValue(1_000);
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
  ctx.isLoggedIn = false;
  ctx.isLoading = false;
  dl.used.clear();
  dl.takePendingDesktopPortalAuth.mockReset().mockResolvedValue(null);
  dl.persistDesktopPortalToken.mockReset();
  dl.takePersistedDesktopPortalToken.mockReset().mockReturnValue(null);
  dl.clearPersistedDesktopPortalToken.mockReset();
  hint.resolvePortalSessionHint.mockReset().mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useDesktopPortalAuth — wiring', () => {
  it('is inert outside the Tauri shell (plain web build never exchanges)', async () => {
    runtime.getTauriInvoke.mockReturnValue(null);
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(dl.takePendingDesktopPortalAuth).not.toHaveBeenCalled());
    expect(ev.listen).not.toHaveBeenCalled();
    expect(api.apiFetch).not.toHaveBeenCalled();
  });

  it('heartbeats session-hint with desktop=1, so a signed-in window clears the handoff flag', async () => {
    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => {
      expect(api.apiFetch).toHaveBeenCalledWith('/api/auth/portal/session-hint?desktop=1');
    });
  });

  const waitingAnnouncements = () => invoke.mock.calls.filter((call) => call[0] === 'announce_desktop_sign_in_wait_command').length;

  it('has the desktop shell tell the Hub it is waiting for a sign-in while the window is signed out, every 60 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    renderHook(() => useDesktopPortalAuth());

    expect(waitingAnnouncements()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(waitingAnnouncements()).toBe(2);
    // The page never sends the proof itself; only the shell can.
    expect(api.apiFetch.mock.calls.some((call) => String(call[0]).includes('desktop-waiting'))).toBe(false);
  });

  it('does not say it is waiting for a sign-in while signed in', async () => {
    ctx.isLoggedIn = true;
    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/api/auth/portal/session-hint?desktop=1'));
    expect(waitingAnnouncements()).toBe(0);
  });

  it('waits for the user context before saying it is waiting, so a signed-in window never does', () => {
    ctx.isLoading = true;
    const { rerender } = renderHook(() => useDesktopPortalAuth());
    expect(waitingAnnouncements()).toBe(0);

    ctx.isLoading = false;
    ctx.isLoggedIn = true;
    rerender();
    expect(waitingAnnouncements()).toBe(0);
  });

  it('stops saying it is waiting once the window signs in', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { rerender } = renderHook(() => useDesktopPortalAuth());
    expect(waitingAnnouncements()).toBe(1);

    ctx.isLoggedIn = true;
    rerender();
    vi.advanceTimersByTime(120_000);
    expect(waitingAnnouncements()).toBe(1);
  });

  it('does not say it is waiting while the window shows a Hub on another machine', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, origin: 'http://hub.ci.lan', hostname: 'hub.ci.lan', port: '', assign: locationAssign },
    });
    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(ev.listen).toHaveBeenCalledWith('deep-link-auth'));
    expect(waitingAnnouncements()).toBe(0);
  });

  it('carries on when the desktop app is too old to have the command', async () => {
    invoke.mockRejectedValue(new Error('Command announce_desktop_sign_in_wait_command not found'));
    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(ev.listen).toHaveBeenCalledWith('deep-link-auth'));
    expect(waitingAnnouncements()).toBe(1);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('remembers the account this window is signed in as, so the sign-in screen can name it after sign-out', async () => {
    api.apiFetch.mockImplementation(async (path: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(path).includes('session-hint')
          ? { email: 'person@example.com', portalBaseUrl: 'https://portal.example.com', source: 'hub_user', portalReachable: true }
          : { sessionId: 'sess-1', redirectPath: '/dashboard' },
    }));

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(hint.rememberPortalAccountEmail).toHaveBeenCalledWith('person@example.com'));
  });

  it('does not remember an email the Hub sent about its first operator rather than this window', async () => {
    api.apiFetch.mockImplementation(async (path: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(path).includes('session-hint')
          ? { email: 'operator@example.com', portalBaseUrl: 'https://portal.example.com', source: 'hub_operator', portalReachable: true }
          : { sessionId: 'sess-1', redirectPath: '/dashboard' },
    }));

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/api/auth/portal/session-hint?desktop=1'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hint.rememberPortalAccountEmail).not.toHaveBeenCalled();
  });

  it('drops an answer that lands after this window signed out, so the next person is not offered the last one', async () => {
    let answer: (value: unknown) => void = () => undefined;
    api.apiFetch.mockImplementation((path: string) =>
      String(path).includes('session-hint')
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : Promise.resolve({ ok: true, status: 200, json: async () => ({ sessionId: 'sess-1', redirectPath: '/dashboard' }) }),
    );

    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/api/auth/portal/session-hint?desktop=1'));

    // Sign out clears the window's session record while the heartbeat still waits on the Hub.
    api.getHubSessionIssuedAt.mockReturnValue(null);
    answer({
      ok: true,
      status: 200,
      json: async () => ({ email: 'person@example.com', portalBaseUrl: 'https://portal.example.com', source: 'hub_user', portalReachable: true }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hint.rememberPortalAccountEmail).not.toHaveBeenCalled();
  });

  it('does not heartbeat desktop presence on iOS/Android (remote Hub owns the callback)', async () => {
    runtime.isTauriDesktopApp.mockReturnValue(false);
    runtime.isMobileClient.mockReturnValue(true);
    runtime.getHubBaseUrlSync.mockReturnValue('https://hub.example.com');

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(ev.listen).toHaveBeenCalled());
    expect(api.apiFetch).not.toHaveBeenCalledWith('/api/auth/portal/session-hint?desktop=1');
    expect(waitingAnnouncements()).toBe(0);
  });

  it('subscribes to deep-link-auth', async () => {
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(ev.listen).toHaveBeenCalledWith('deep-link-auth'));
  });

  it('starts listening when a phone picks its Hub without a reload, and stops when it forgets it', async () => {
    runtime.isTauriDesktopApp.mockReturnValue(false);
    runtime.isMobileClient.mockReturnValue(true);
    runtime.getHubBaseUrlSync.mockReturnValue(null);

    const { rerender } = renderHook(() => useDesktopPortalAuth());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ev.listen).not.toHaveBeenCalled();

    // /connect sets the Hub and navigates in place; the next render sees Hub sign-in.
    runtime.getHubBaseUrlSync.mockReturnValue('https://hub.example.com');
    rerender();
    await waitFor(() => expect(ev.listen).toHaveBeenCalledWith('deep-link-auth'));

    runtime.getHubBaseUrlSync.mockReturnValue(null);
    rerender();
    await waitFor(() => expect(ev.unlisten).toHaveBeenCalled());
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

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('COMMON_AN_ERROR_OCCURRED', { id: 'desktop-portal-exchange' }));
    expect(api.setTauriSessionId).not.toHaveBeenCalled();
    expect(locationAssign).not.toHaveBeenCalled();
  });
});

describe('useDesktopPortalAuth — the same link arriving more than once', () => {
  const exchangeCalls = () => api.apiFetch.mock.calls.filter((call) => String(call[0]).includes('desktop-exchange'));
  const refuseExchange = () =>
    api.apiFetch.mockImplementation(async (path: string) =>
      String(path).includes('desktop-exchange')
        ? { ok: false, status: 400, json: async () => ({ message: 'Invalid or expired desktop exchange token' }) }
        : { ok: true, status: 200, json: async () => ({}) },
    );

  it('does not exchange the parked copy again on the page load after sign-in', async () => {
    const first = renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(ev.handler).not.toBeNull());
    ev.handler?.({ payload: { token: 'tok-signin' } });
    await waitFor(() => expect(locationAssign).toHaveBeenCalledWith('/dashboard'));
    first.unmount();

    // The reload after sign-in: a fresh page takes the copy the shell parked for it.
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-signin' });
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(dl.takePendingDesktopPortalAuth).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(exchangeCalls()).toHaveLength(1);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('empties the parked slot when the link arrives as an event', async () => {
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(ev.handler).not.toBeNull());
    await waitFor(() => expect(dl.takePendingDesktopPortalAuth).toHaveBeenCalledTimes(1));

    ev.handler?.({ payload: { token: 'tok-event' } });

    await waitFor(() => expect(dl.takePendingDesktopPortalAuth).toHaveBeenCalledTimes(2));
    expect(exchangeCalls()).toHaveLength(1);
  });

  it('forgets a refused token instead of retrying it on every page load', async () => {
    refuseExchange();
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-dead' });
    const first = renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('AUTH_PORTAL_ERROR_STATE_EXPIRED', { id: 'desktop-portal-exchange' }));
    expect(dl.clearPersistedDesktopPortalToken).toHaveBeenCalled();
    first.unmount();

    dl.takePendingDesktopPortalAuth.mockResolvedValue(null);
    dl.takePersistedDesktopPortalToken.mockReturnValue('tok-dead');
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(dl.takePersistedDesktopPortalToken).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(exchangeCalls()).toHaveLength(1);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  it('drops a refused token recovered from storage without a toast', async () => {
    refuseExchange();
    dl.takePersistedDesktopPortalToken.mockReturnValue('tok-saved');

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(exchangeCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(dl.used.has('tok-saved')).toBe(true);
  });

  it('drops a refused stale link silently when already signed in', async () => {
    ctx.isLoggedIn = true;
    refuseExchange();
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-stale' });

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(exchangeCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(dl.clearPersistedDesktopPortalToken).toHaveBeenCalled();
  });

  it('clears the saved token when the Hub cannot be reached', async () => {
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-offline' });
    api.apiFetch.mockRejectedValue(new Error('offline'));

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('COMMON_AN_ERROR_OCCURRED', { id: 'desktop-portal-exchange' }));
    expect(dl.clearPersistedDesktopPortalToken).toHaveBeenCalled();
  });

  it('treats a non-400 refusal as a failed attempt, not a dead token', async () => {
    api.apiFetch.mockImplementation(async (path: string) =>
      String(path).includes('desktop-exchange')
        ? { ok: false, status: 429, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({}) },
    );
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-throttled' });

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('COMMON_AN_ERROR_OCCURRED', { id: 'desktop-portal-exchange' }));
    expect(dl.used.has('tok-throttled')).toBe(false);
    expect(dl.clearPersistedDesktopPortalToken).toHaveBeenCalled();
  });

  it('keeps a single subscription while the user context changes', async () => {
    const { rerender } = renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(ev.listen).toHaveBeenCalledTimes(1));

    ctx.setUserContext = vi.fn();
    rerender();
    ctx.isLoggedIn = true;
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ev.listen).toHaveBeenCalledTimes(1);
    expect(ev.unlisten).not.toHaveBeenCalled();
    expect(api.apiFetch.mock.calls.filter((call) => call[0] === '/api/auth/portal/session-hint?desktop=1')).toHaveLength(1);
  });
});
