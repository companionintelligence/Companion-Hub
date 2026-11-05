import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTauriSessionId } from '@/lib/api-fetch';
import { DesktopSignInError, signInDesktopWithPortal } from './desktop-portal-sign-in';

// The system browser is the only thing the test cannot run: it captures the authorize URL instead.
const { openAuthInSystemBrowser, authorizeUrls } = vi.hoisted(() => {
  const authorizeUrls: string[] = [];
  return {
    authorizeUrls,
    openAuthInSystemBrowser: vi.fn(async (url: string) => {
      authorizeUrls.push(url);
    }),
  };
});
vi.mock('@/lib/helpers/open-auth-browser', () => ({ openAuthInSystemBrowser }));

// Only the Hub calls are faked. setTauriSessionId stays real, so the keychain write it makes is checked too.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-fetch')>()),
  apiFetch,
}));

vi.mock('@/lib/mobile-connection', () => ({
  isTauriMobileSync: () => false,
  isMobileClient: () => false,
}));

const PORTAL = 'https://portal.example.test';
const TOKEN_ENDPOINT = `${PORTAL}/api/auth/oauth2/token`;
const LOOPBACK_REDIRECT = 'http://127.0.0.1:53123/callback';

/** The OS keychain behind the fake Tauri IPC. */
const keychain = new Map<string, string>();

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  const key = String(args?.key);
  switch (cmd) {
    case 'plugin:ci-auth|begin_loopback':
      return { port: 53123, redirectUri: LOOPBACK_REDIRECT };
    case 'plugin:ci-auth|await_loopback': {
      // The Portal sends the browser back with the state it was given, so echo the one on the authorize URL.
      const authorize = new URL(authorizeUrls[authorizeUrls.length - 1] ?? 'https://not-opened.invalid/');
      return { url: `${LOOPBACK_REDIRECT}?code=test-code&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}` };
    }
    case 'plugin:ci-auth|secure_get':
      return { value: keychain.get(key) ?? null };
    case 'plugin:ci-auth|secure_set':
      keychain.set(key, String(args?.value));
      return undefined;
    case 'plugin:ci-auth|secure_remove':
      keychain.delete(key);
      return undefined;
    case 'plugin:ci-auth|cancel_loopback':
      return undefined;
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
});

type TauriWindow = { __TAURI_INTERNALS__?: { invoke: typeof invoke } };
const tauriWindow = window as unknown as TauriWindow;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const tokenFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
  if (String(input) === TOKEN_ENDPOINT) {
    return jsonResponse({ access_token: 'portal-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'portal-refresh' });
  }
  throw new Error(`unexpected fetch ${String(input)}`);
});

/** The S256 challenge for a verifier, computed here rather than with the vendored helper, so the check is independent. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

beforeEach(() => {
  keychain.clear();
  authorizeUrls.length = 0;
  openAuthInSystemBrowser.mockClear();
  invoke.mockClear();
  tauriWindow.__TAURI_INTERNALS__ = { invoke };
  setTauriSessionId(null);
  tokenFetch.mockClear();
  vi.stubGlobal('fetch', tokenFetch);
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/auth/portal/desktop-config') {
      return jsonResponse({ portalUrl: PORTAL });
    }
    if (path === '/api/auth/portal/desktop-session') {
      return jsonResponse({ sessionId: 'hub-session-1', redirectPath: '/home' });
    }
    throw new Error(`unexpected apiFetch ${path}`);
  });
});

afterEach(() => {
  setTauriSessionId(null);
  vi.unstubAllGlobals();
  delete tauriWindow.__TAURI_INTERNALS__;
});

describe('signInDesktopWithPortal', () => {
  it('opens a PKCE authorize request on the loopback redirect, with no token in it', async () => {
    await signInDesktopWithPortal();

    expect(authorizeUrls).toHaveLength(1);
    const url = new URL(authorizeUrls[0] ?? '');
    expect(url.origin + url.pathname).toBe(`${PORTAL}/api/auth/oauth2/authorize`);
    expect(url.searchParams.get('client_id')).toBe('ci-hub');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(LOOPBACK_REDIRECT);
    // No parameter a token or the verifier could travel in.
    expect(Array.from(url.searchParams.keys()).filter((name) => /token|verifier/i.test(name))).toEqual([]);
  });

  it('exchanges the code at the Portal token endpoint with the verifier that matches the challenge', async () => {
    await signInDesktopWithPortal();

    expect(tokenFetch).toHaveBeenCalledTimes(1);
    const [tokenUrl, init] = tokenFetch.mock.calls[0] ?? [];
    expect(String(tokenUrl)).toBe(TOKEN_ENDPOINT);
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('test-code');
    expect(body.get('client_id')).toBe('ci-hub');

    const verifier = body.get('code_verifier') ?? '';
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(new URL(authorizeUrls[0] ?? '').searchParams.get('code_challenge')).toBe(await s256(verifier));
  });

  it('sends the Portal access token to the Hub in an Authorization header, never in the URL', async () => {
    await signInDesktopWithPortal();

    const [path, init] = apiFetch.mock.calls.find(([called]) => called === '/api/auth/portal/desktop-session') ?? [];
    expect(path).toBe('/api/auth/portal/desktop-session');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer portal-access' });
  });

  it('keeps the Portal refresh token and the Hub session id in the keychain, and no access token', async () => {
    await signInDesktopWithPortal();

    await vi.waitFor(() => expect(keychain.get('ci.hub.session')).toBe('hub-session-1'));
    expect(keychain.get('ci.auth.ci-hub.refresh')).toBe('portal-refresh');
    expect(Array.from(keychain.values())).not.toContain('portal-access');
  });

  it('resolves with the redirect path the Hub returned', async () => {
    await expect(signInDesktopWithPortal()).resolves.toEqual({ redirectPath: '/home' });
  });

  it('rejects with a DesktopSignInError carrying the status when the Hub refuses the Portal sign-in', async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === '/api/auth/portal/desktop-config' ? jsonResponse({ portalUrl: PORTAL }) : jsonResponse({ message: 'unauthorized' }, 401),
    );

    const failure = signInDesktopWithPortal();
    await expect(failure).rejects.toBeInstanceOf(DesktopSignInError);
    await expect(failure).rejects.toMatchObject({ status: 401 });
  });
});
