import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTauriSessionId } from '@/lib/api-fetch';
import { addressingHub, DesktopSignInError, nativeTokenFetch, signInDesktopWithPortal } from './desktop-portal-sign-in';

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
    // The desktop's native token request (src/portal_token.rs), standing in for Portal here.
    case 'portal_token_request_command': {
      const response = await tokenFetch(String(args?.endpoint), { method: 'POST', body: String(args?.body) });
      return { status: response.status, body: await response.text() };
    }
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
});

type TauriWindow = { __TAURI_INTERNALS__?: { invoke: typeof invoke } };
const tauriWindow = window as unknown as TauriWindow;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The id_token Portal's token reply carries; a test sets it to undefined for a reply without one. */
const idTokenReply: { value: string | undefined } = { value: 'portal-id-token' };

const tokenFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
  if (String(input) === TOKEN_ENDPOINT) {
    return jsonResponse({
      access_token: 'portal-access',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'portal-refresh',
      id_token: idTokenReply.value,
    });
  }
  throw new Error(`unexpected fetch ${String(input)}`);
});

const webviewFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  throw new TypeError(`the WebView fetch was used for ${String(input)}`);
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
  idTokenReply.value = 'portal-id-token';
  keychain.clear();
  authorizeUrls.length = 0;
  openAuthInSystemBrowser.mockClear();
  invoke.mockClear();
  tauriWindow.__TAURI_INTERNALS__ = { invoke };
  setTauriSessionId(null);
  tokenFetch.mockClear();
  // The WebView's own fetch can never read Portal's token reply (Portal answers CORS for its own UI
  // only), so the sign-in must not use it.
  vi.stubGlobal('fetch', webviewFetch);
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/auth/portal/desktop-config') {
      return jsonResponse({ portalUrl: PORTAL, deviceId: 'hub-device-1' });
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

    // Through the desktop app, never the WebView.
    expect(webviewFetch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('portal_token_request_command', expect.objectContaining({ endpoint: TOKEN_ENDPOINT }));

    expect(tokenFetch).toHaveBeenCalledTimes(1);
    const [tokenUrl, init] = tokenFetch.mock.calls[0] ?? [];
    expect(String(tokenUrl)).toBe(TOKEN_ENDPOINT);
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('test-code');
    expect(body.get('client_id')).toBe('ci-hub');
    // Names this Hub, so Portal addresses the id_token to it and no other Hub can spend it.
    expect(body.get('resource')).toBe('urn:ci:device:hub-device-1');

    const verifier = body.get('code_verifier') ?? '';
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(new URL(authorizeUrls[0] ?? '').searchParams.get('code_challenge')).toBe(await s256(verifier));
  });

  it('sends the Portal access token and id_token to the Hub in headers, never in the URL', async () => {
    await signInDesktopWithPortal();

    const [path, init] = apiFetch.mock.calls.find(([called]) => called === '/api/auth/portal/desktop-session') ?? [];
    expect(path).toBe('/api/auth/portal/desktop-session');
    expect(init.method).toBe('POST');
    // The id_token says the sign-in was for the Hub's own client; an access token alone does not.
    expect(init.headers).toEqual({ Authorization: 'Bearer portal-access', 'X-Portal-Id-Token': 'portal-id-token' });
  });

  it('stops before asking the Hub when Portal returned no id_token', async () => {
    idTokenReply.value = undefined;

    await expect(signInDesktopWithPortal()).rejects.toBeInstanceOf(DesktopSignInError);
    expect(apiFetch.mock.calls.some(([called]) => called === '/api/auth/portal/desktop-session')).toBe(false);
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

describe('addressingHub', () => {
  const sent = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
  const bodyOf = (call: number) => new URLSearchParams(String(sent.mock.calls[call]?.[1]?.body));

  it('names the Hub on the code exchange only: Portal refuses resource on a refresh', async () => {
    const fetch = addressingHub(sent, 'dev-1');
    await fetch(TOKEN_ENDPOINT, { method: 'POST', body: 'grant_type=authorization_code&code=c&code_verifier=v' });
    await fetch(TOKEN_ENDPOINT, { method: 'POST', body: 'grant_type=refresh_token&refresh_token=r' });

    expect(bodyOf(0).get('resource')).toBe('urn:ci:device:dev-1');
    expect(bodyOf(0).get('code')).toBe('c');
    expect(bodyOf(1).has('resource')).toBe(false);
  });

  it('replaces a resource already in the body rather than sending two', async () => {
    await addressingHub(sent, 'dev-1')(TOKEN_ENDPOINT, { method: 'POST', body: 'grant_type=authorization_code&resource=urn%3Aci%3Adevice%3Aother' });

    expect(new URLSearchParams(String(sent.mock.calls.at(-1)?.[1]?.body)).getAll('resource')).toEqual(['urn:ci:device:dev-1']);
  });
});

describe('nativeTokenFetch', () => {
  it('turns the native answer into the Response the token client reads', async () => {
    const native = vi.fn(async () => ({ status: 400, body: '{"error":"invalid_grant"}' }));
    const response = await nativeTokenFetch(native as never)(TOKEN_ENDPOINT, { method: 'POST', body: 'grant_type=authorization_code' });

    expect(native).toHaveBeenCalledWith('portal_token_request_command', { endpoint: TOKEN_ENDPOINT, body: 'grant_type=authorization_code' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('rejects an answer with no usable status, as a network failure would', async () => {
    const native = vi.fn(async () => ({ status: 0, body: '' }));
    await expect(nativeTokenFetch(native as never)(TOKEN_ENDPOINT, { body: 'x' })).rejects.toThrow();
  });

  it('rejects at once when the sign-in was already cancelled', async () => {
    const native = vi.fn(async () => ({ status: 200, body: '{}' }));
    const controller = new AbortController();
    controller.abort();

    await expect(nativeTokenFetch(native as never)(TOKEN_ENDPOINT, { body: 'x', signal: controller.signal })).rejects.toBeDefined();
    expect(native).not.toHaveBeenCalled();
  });
});
