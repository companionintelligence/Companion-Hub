import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@/tests/test-utils';

/**
 * Tests the Portal SSO handoff: the browser finishes sign-in at the Portal and
 * hands back a ONE-TIME token over a `cihub://` deep link, which this hook
 * exchanges for the `X-CI-Hub-Session` id.
 *
 * The token is the whole credential, so the replay guard is the security
 * property under test — and it has a deliberate subtlety: a *failed* exchange
 * releases the token so the user can retry, while a *successful* one is burned
 * forever. Both halves are covered below; the key mapping in
 * lib/portal-auth-errors.ts is left unmocked so the real keys are asserted.
 */

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('react-router', async (orig) => ({
  ...(await orig<typeof import('react-router')>()),
  useNavigate: () => nav.navigate,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const toastMock = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: { error: (...a: unknown[]) => toastMock.error(...a) } }));

const ctx = vi.hoisted(() => ({ refreshUserContext: vi.fn(), setUserContext: vi.fn() }));
vi.mock('@/context/user-context', () => ({ useUserContext: () => ctx }));

const api = vi.hoisted(() => ({ exchangePortalDesktopLogin: vi.fn() }));
vi.mock('@/api-client/sdk.gen', () => ({
  exchangePortalDesktopLogin: (...a: unknown[]) => api.exchangePortalDesktopLogin(...a),
}));

const fetchLib = vi.hoisted(() => ({ setTauriSessionId: vi.fn() }));
vi.mock('@/lib/api-fetch', () => ({ setTauriSessionId: (...a: unknown[]) => fetchLib.setTauriSessionId(...a) }));

const dl = vi.hoisted(() => ({ takePendingDesktopPortalAuth: vi.fn() }));
vi.mock('@/lib/deep-link-auth', () => ({ takePendingDesktopPortalAuth: () => dl.takePendingDesktopPortalAuth() }));

const hint = vi.hoisted(() => ({ rememberPortalAccountEmail: vi.fn(), resolvePortalSessionHint: vi.fn() }));
vi.mock('@/lib/portal-session-hint', () => ({
  rememberPortalAccountEmail: (...a: unknown[]) => hint.rememberPortalAccountEmail(...a),
  resolvePortalSessionHint: () => hint.resolvePortalSessionHint(),
}));

// Capture the `deep-link-auth` listener so tests can fire handoffs at it.
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

const win = window as unknown as Record<string, unknown>;
const setDesktop = (on: boolean) => {
  if (on) {
    win.__TAURI_INTERNALS__ = {};
  } else {
    delete win.__TAURI_INTERNALS__;
  }
};

/** When a mock was first invoked, relative to every other mock in the test. */
const firstCallOrder = (m: { mock: { invocationCallOrder: number[] } }): number => {
  const [first] = m.mock.invocationCallOrder;
  expect(first).toBeDefined();
  return first ?? Number.NaN;
};

const exchangeOk = (redirectPath = '/dashboard', sessionId = 'sess-1') => ({
  data: { sessionId, redirectPath },
  response: new Response(null, { status: 200 }),
});
const exchangeHttpError = (status = 401) => ({ data: undefined, response: new Response(null, { status }) });

beforeEach(() => {
  setDesktop(true);
  ev.handler = null;
  for (const m of [nav.navigate, toastMock.error, ev.unlisten, ev.listen, fetchLib.setTauriSessionId, hint.rememberPortalAccountEmail]) {
    m.mockClear();
  }
  ctx.refreshUserContext.mockReset().mockResolvedValue(undefined);
  ctx.setUserContext.mockReset();
  api.exchangePortalDesktopLogin.mockReset().mockResolvedValue(exchangeOk());
  dl.takePendingDesktopPortalAuth.mockReset().mockResolvedValue(null);
  hint.resolvePortalSessionHint.mockReset().mockResolvedValue({ email: null, portalBaseUrl: null, source: null });
});

describe('useDesktopPortalAuth — wiring', () => {
  it('is inert outside the Tauri shell (plain web build never exchanges)', async () => {
    setDesktop(false);
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(dl.takePendingDesktopPortalAuth).not.toHaveBeenCalled());
    expect(ev.listen).not.toHaveBeenCalled();
    expect(api.exchangePortalDesktopLogin).not.toHaveBeenCalled();
  });

  it('subscribes to deep-link-auth', async () => {
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(ev.listen).toHaveBeenCalledWith('deep-link-auth'));
  });

  it('drops the listener on unmount', async () => {
    const { unmount } = renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(ev.listen).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(ev.unlisten).toHaveBeenCalled());
  });
});

describe('useDesktopPortalAuth — successful handoff', () => {
  it('exchanges a token stashed before the UI mounted (cold start) and lands on the redirect', async () => {
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-cold' });

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/dashboard'));
    expect(api.exchangePortalDesktopLogin).toHaveBeenCalledWith({ query: { token: 'tok-cold' } });
    expect(fetchLib.setTauriSessionId).toHaveBeenCalledWith('sess-1');
    expect(ctx.setUserContext).toHaveBeenCalledWith({ isLoggedIn: true });
    expect(ctx.refreshUserContext).toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('exchanges a token that arrives while the app is already running', async () => {
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: { token: 'tok-live' } });

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/dashboard'));
    expect(api.exchangePortalDesktopLogin).toHaveBeenCalledWith({ query: { token: 'tok-live' } });
  });

  it('installs the session BEFORE refreshing the context', async () => {
    // Ordering is load-bearing: refreshUserContext is an authenticated call, so
    // it 401s if the session id is not on the client yet.
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-order' });

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(ctx.refreshUserContext).toHaveBeenCalled());
    expect(firstCallOrder(fetchLib.setTauriSessionId)).toBeLessThan(firstCallOrder(ctx.refreshUserContext));
  });

  it('falls back to /home when the Portal returns no redirect path', async () => {
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-noredirect' });
    api.exchangePortalDesktopLogin.mockResolvedValue(exchangeOk(''));

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/home'));
  });

  it('remembers the Portal email so the next sign-in can prefill it', async () => {
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-hint' });
    hint.resolvePortalSessionHint.mockResolvedValue({ email: 'liam@ci.computer', portalBaseUrl: null, source: 'portal_session' });

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(hint.rememberPortalAccountEmail).toHaveBeenCalledWith('liam@ci.computer'));
  });

  it('remembers nothing when the hint has no email', async () => {
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-nohint' });

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(nav.navigate).toHaveBeenCalled());
    expect(hint.rememberPortalAccountEmail).not.toHaveBeenCalled();
  });
});

describe('useDesktopPortalAuth — one-time token replay guard', () => {
  it('exchanges a given token only once, however many times it is redelivered', async () => {
    // The OS can redeliver a deep link (relaunch, duplicate event). The token is
    // single-use at the Hub, so a second exchange would 400 and strand the user
    // on an error toast right after a *successful* login.
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: { token: 'tok-replay' } });
    await waitFor(() => expect(nav.navigate).toHaveBeenCalledTimes(1));

    ev.handler?.({ payload: { token: 'tok-replay' } });
    ev.handler?.({ payload: { token: 'tok-replay' } });
    await new Promise((r) => setTimeout(r, 10));

    expect(api.exchangePortalDesktopLogin).toHaveBeenCalledTimes(1);
    expect(nav.navigate).toHaveBeenCalledTimes(1);
  });

  it('releases the token after a failure so the user can retry the same deep link', async () => {
    // The mirror of the guard above: a transient network failure must not burn
    // the token, or re-opening the link is silently dead and the only way out
    // is a full re-auth at the Portal.
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    api.exchangePortalDesktopLogin.mockRejectedValueOnce(new Error('network down'));
    ev.handler?.({ payload: { token: 'tok-retry' } });
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('COMMON_AN_ERROR_OCCURRED'));
    expect(nav.navigate).not.toHaveBeenCalled();

    ev.handler?.({ payload: { token: 'tok-retry' } });

    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/dashboard'));
    expect(api.exchangePortalDesktopLogin).toHaveBeenCalledTimes(2);
  });
});

describe('useDesktopPortalAuth — failure handling', () => {
  it('does not sign the user in when the exchange rejects', async () => {
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-throw' });
    api.exchangePortalDesktopLogin.mockRejectedValue(new Error('boom'));

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('COMMON_AN_ERROR_OCCURRED'));
    expect(fetchLib.setTauriSessionId).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('treats a non-2xx exchange as a failure even though the request resolved', async () => {
    // A rejected token comes back as an HTTP error, not a thrown error — the
    // result.ok check is the only thing standing between that and a bogus
    // "logged in" state with an undefined session id.
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ token: 'tok-401' });
    api.exchangePortalDesktopLogin.mockResolvedValue(exchangeHttpError(401));

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('COMMON_AN_ERROR_OCCURRED'));
    expect(fetchLib.setTauriSessionId).not.toHaveBeenCalled();
    expect(ctx.setUserContext).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});

describe('useDesktopPortalAuth — Portal error payloads', () => {
  it('surfaces a known Portal error and never attempts an exchange', async () => {
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ error: 'account_mismatch' });

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('AUTH_PORTAL_ERROR_ACCOUNT_MISMATCH'));
    expect(api.exchangePortalDesktopLogin).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('falls back to a generic message for an unrecognised Portal error', async () => {
    dl.takePendingDesktopPortalAuth.mockResolvedValue({ error: 'something_new_from_the_portal' });

    renderHook(() => useDesktopPortalAuth());

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('AUTH_PORTAL_ERROR_CALLBACK_ERROR'));
  });

  it('shows a repeated error once, but a different error still gets through', async () => {
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(ev.handler).toBeTruthy());

    ev.handler?.({ payload: { error: 'state_expired' } });
    ev.handler?.({ payload: { error: 'state_expired' } });
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('AUTH_PORTAL_ERROR_STATE_EXPIRED'));
    expect(toastMock.error).toHaveBeenCalledTimes(1);

    ev.handler?.({ payload: { error: 'not_configured' } });
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('AUTH_PORTAL_ERROR_NOT_CONFIGURED'));
    expect(toastMock.error).toHaveBeenCalledTimes(2);
  });

  it('ignores an empty handoff (nothing pending, no token, no error)', async () => {
    renderHook(() => useDesktopPortalAuth());
    await waitFor(() => expect(dl.takePendingDesktopPortalAuth).toHaveBeenCalled());

    ev.handler?.({ payload: null });
    ev.handler?.({ payload: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(api.exchangePortalDesktopLogin).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});
