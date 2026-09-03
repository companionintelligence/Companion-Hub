import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { emailFromIdToken, loginWithPortalOidc, OIDC_CLIENT_ID, OIDC_REDIRECT_URI, resumePendingOidcLogin } from './oidc';
import { DEFAULT_PORTAL_URL } from './portal-client';

const openUrl = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (...a: unknown[]) => openUrl(...a) }));

const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => httpFetch(...a) }));

const invoke = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

// Capture listeners by event so we can fire the desktop or iOS path.
const listeners = new Map<string, (event: { payload: string | string[] }) => void>();
const unlisten = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: string | string[] }) => void) => {
    listeners.set(event, cb);
    return unlisten;
  }),
}));

function anyListener(): ((event: { payload: string | string[] }) => void) | undefined {
  return listeners.get('deep-link://new-url') ?? listeners.get('deep-link-oidc');
}

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function resetDeepLinkHandlers(): void {
  listeners.clear();
}

beforeEach(() => {
  openUrl.mockClear();
  httpFetch.mockReset();
  unlisten.mockClear();
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  listeners.clear();
  sessionStorage.clear();
  localStorage.clear();
});

/** Drive the flow: wait for the authorize URL + listener, then fire the callback. */
async function fireCallback(code: string, stateOverride?: string, eventName = 'deep-link://new-url') {
  await vi.waitFor(() => {
    expect(openUrl).toHaveBeenCalled();
    expect(anyListener()).toBeTruthy();
  });
  const authorizeUrl = new URL(openUrl.mock.calls[0]?.[0] as string);
  const state = stateOverride ?? authorizeUrl.searchParams.get('state') ?? '';
  listeners.get(eventName)?.({ payload: `${OIDC_REDIRECT_URI}?code=${code}&state=${state}` });
  return authorizeUrl;
}

describe('loginWithPortalOidc', () => {
  it('runs the PKCE authorize → callback → token exchange and returns tokens', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT', id_token: 'IT', token_type: 'Bearer', expires_in: 3600 }));

    const promise = loginWithPortalOidc();
    const authorizeUrl = await fireCallback('auth-code-1');
    const tokens = await promise;

    expect(tokens).toEqual({ accessToken: 'AT', idToken: 'IT', tokenType: 'Bearer', expiresIn: 3600 });

    // authorize URL is a correct PKCE request
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(`${DEFAULT_PORTAL_URL}/api/auth/oauth2/authorize`);
    expect(authorizeUrl.searchParams.get('client_id')).toBe(OIDC_CLIENT_ID);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(OIDC_REDIRECT_URI);
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    // token exchange posts the code + PKCE verifier
    const [tokenUrl, init] = httpFetch.mock.calls[0] ?? [];
    expect(tokenUrl).toBe(`${DEFAULT_PORTAL_URL}/api/auth/oauth2/token`);
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(unlisten).toHaveBeenCalled(); // listener cleaned up
  });

  it('ignores a callback whose state does not match (CSRF / leftover hop)', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const promise = loginWithPortalOidc();
    await fireCallback('code', 'tampered-state');
    expect(httpFetch).not.toHaveBeenCalled();
    const authorizeUrl = new URL(openUrl.mock.calls[0]?.[0] as string);
    const state = authorizeUrl.searchParams.get('state') ?? '';
    anyListener()?.({ payload: `${OIDC_REDIRECT_URI}?code=real&state=${state}` });
    await expect(promise).resolves.toMatchObject({ accessToken: 'AT' });
  });

  it('redeems an authorization code only once when resume races the live waiter', async () => {
    let release!: (value: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    httpFetch.mockImplementation(() => held);

    const promise = loginWithPortalOidc();
    await fireCallback('once-code');
    await vi.waitFor(() => expect(httpFetch).toHaveBeenCalledTimes(1));

    const authorizeUrl = new URL(openUrl.mock.calls[0]?.[0] as string);
    const state = authorizeUrl.searchParams.get('state') ?? '';
    invoke.mockResolvedValue(`${OIDC_REDIRECT_URI}?code=once-code&state=${state}`);

    const resume = resumePendingOidcLogin();
    release(tokenResponse({ access_token: 'AT' }));

    await expect(promise).resolves.toMatchObject({ accessToken: 'AT' });
    await expect(resume).resolves.toMatchObject({ accessToken: 'AT' });
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces a token-exchange failure', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ error_description: 'bad verifier' }, 400));
    const promise = loginWithPortalOidc();
    await fireCallback('code');
    await expect(promise).rejects.toThrow('bad verifier');
  });
});

/**
 * PKCE is the whole defense for a public client using a custom-scheme redirect:
 * `cihub://` can be claimed by another installed app, so an attacker who steals
 * the authorization code still cannot exchange it without the verifier. These
 * assert the cryptographic properties rather than just param presence.
 */
describe('loginWithPortalOidc — PKCE security properties', () => {
  /** Recompute the S256 challenge the way a spec-compliant server would. */
  async function s256(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  it('sends a code_challenge that is the real SHA-256 of the code_verifier', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT' }));

    const promise = loginWithPortalOidc();
    const authorizeUrl = await fireCallback('code');
    await promise;

    const challenge = authorizeUrl.searchParams.get('code_challenge') ?? '';
    const verifier = new URLSearchParams(httpFetch.mock.calls[0]?.[1].body).get('code_verifier') ?? '';

    // If this drifts, the Portal rejects every exchange — or worse, someone
    // "fixes" it by switching to method=plain and silently removes the defense.
    expect(verifier).not.toBe('');
    expect(challenge).toBe(await s256(verifier));
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('never leaks the code_verifier to the browser/authorize URL', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT' }));

    const promise = loginWithPortalOidc();
    const authorizeUrl = await fireCallback('code');
    await promise;

    const verifier = new URLSearchParams(httpFetch.mock.calls[0]?.[1].body).get('code_verifier') ?? '';
    // The verifier must exist only in app memory + the token POST. Leaking it
    // into the browser-visible URL would defeat PKCE entirely.
    expect(authorizeUrl.toString()).not.toContain(verifier);
    expect(String(openUrl.mock.calls[0]?.[0])).not.toContain(verifier);
  });

  it('generates a fresh verifier and state per sign-in (no replay across attempts)', async () => {
    // mockImplementation (not mockResolvedValue): each call needs its own
    // Response — a body can only be read once.
    httpFetch.mockImplementation(async () => tokenResponse({ access_token: 'AT' }));

    const first = loginWithPortalOidc();
    const urlA = await fireCallback('code-a');
    await first;
    const verifierA = new URLSearchParams(httpFetch.mock.calls[0]?.[1].body).get('code_verifier');

    // Reset the captured handlers so the second run registers its own.
    resetDeepLinkHandlers();
    httpFetch.mockClear();
    openUrl.mockClear();

    const second = loginWithPortalOidc();
    await vi.waitFor(() => {
      expect(openUrl).toHaveBeenCalled();
      expect(anyListener()).toBeTruthy();
    });
    const urlB = new URL(openUrl.mock.calls[0]?.[0] as string);
    anyListener()?.({ payload: `${OIDC_REDIRECT_URI}?code=code-b&state=${urlB.searchParams.get('state')}` });
    await second;
    const verifierB = new URLSearchParams(httpFetch.mock.calls[0]?.[1].body).get('code_verifier');

    expect(urlA.searchParams.get('state')).not.toBe(urlB.searchParams.get('state'));
    expect(urlA.searchParams.get('code_challenge')).not.toBe(urlB.searchParams.get('code_challenge'));
    expect(verifierA).not.toBe(verifierB);
  });
});

describe('loginWithPortalOidc — callback handling', () => {
  it('surfaces an error returned by the Portal (user denied consent)', async () => {
    const promise = loginWithPortalOidc();
    await vi.waitFor(() => expect(anyListener()).toBeTruthy());
    anyListener()?.({ payload: `${OIDC_REDIRECT_URI}?error=access_denied&error_description=User%20denied%20access` });

    await expect(promise).rejects.toThrow('User denied access');
    expect(httpFetch).not.toHaveBeenCalled(); // never try to exchange
  });

  it('falls back to the raw error code when no description is given', async () => {
    const promise = loginWithPortalOidc();
    await vi.waitFor(() => expect(anyListener()).toBeTruthy());
    anyListener()?.({ payload: `${OIDC_REDIRECT_URI}?error=server_error` });
    await expect(promise).rejects.toThrow('server_error');
  });

  it('ignores unrelated deep links and keeps waiting for the real callback', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const promise = loginWithPortalOidc();
    await vi.waitFor(() => expect(anyListener()).toBeTruthy());

    // A pairing link or an App Intent arriving mid-login must not resolve or
    // reject the OIDC flow — they belong to other consumers.
    anyListener()?.({ payload: 'cihub://pair?code=abc123' });
    anyListener()?.({ payload: 'cihub://intent/settings' });
    anyListener()?.({ payload: `${OIDC_REDIRECT_URI}?state=only-state-no-code` });
    expect(httpFetch).not.toHaveBeenCalled();

    // The genuine callback still completes the flow.
    const url = new URL(openUrl.mock.calls[0]?.[0] as string);
    anyListener()?.({ payload: `${OIDC_REDIRECT_URI}?code=real&state=${url.searchParams.get('state')}` });
    await expect(promise).resolves.toMatchObject({ accessToken: 'AT' });
  });

  it('handles an array payload (the plugin may batch deep links)', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const promise = loginWithPortalOidc();
    await vi.waitFor(() => expect(anyListener()).toBeTruthy());

    const url = new URL(openUrl.mock.calls[0]?.[0] as string);
    anyListener()?.({ payload: ['cihub://pair?code=abc123', `${OIDC_REDIRECT_URI}?code=real&state=${url.searchParams.get('state')}`] });

    await expect(promise).resolves.toMatchObject({ accessToken: 'AT' });
  });

  it('rejects when event.listen is denied instead of spinning forever', async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error('event.listen not allowed on window "main"'));

    await expect(loginWithPortalOidc()).rejects.toThrow(/not allowed/);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('cancels quietly when the caller aborts, and drops the listener', async () => {
    const controller = new AbortController();
    const promise = loginWithPortalOidc(undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(anyListener()).toBeTruthy());

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'OidcCancelledError' });
    expect(unlisten).toHaveBeenCalled(); // no leaked listener after cancel
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('rejects immediately when handed an already-aborted signal', async () => {
    const promise = loginWithPortalOidc(undefined, { signal: AbortSignal.abort() });
    await expect(promise).rejects.toMatchObject({ name: 'OidcCancelledError' });
  });

  it('defaults token_type and tolerates a response without id_token/expires_in', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const promise = loginWithPortalOidc();
    await fireCallback('code');
    await expect(promise).resolves.toEqual({ accessToken: 'AT', idToken: null, tokenType: 'Bearer', expiresIn: null });
  });

  it('honors a custom Portal URL and strips a trailing slash', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const promise = loginWithPortalOidc('https://staging.example.com/');
    const url = await fireCallback('code');
    await promise;

    expect(url.origin + url.pathname).toBe('https://staging.example.com/api/auth/oauth2/authorize');
    expect(httpFetch.mock.calls[0]?.[0]).toBe('https://staging.example.com/api/auth/oauth2/token');
  });

  it('completes when iOS delivers the callback on deep-link-oidc (not the desktop event)', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const promise = loginWithPortalOidc();
    await fireCallback('ios-code', undefined, 'deep-link-oidc');
    await expect(promise).resolves.toMatchObject({ accessToken: 'AT' });
    const body = new URLSearchParams(httpFetch.mock.calls[0]?.[1].body);
    expect(body.get('code')).toBe('ios-code');
  });
});

describe('resumePendingOidcLogin', () => {
  it('returns null when nothing is pending', async () => {
    await expect(resumePendingOidcLogin()).resolves.toBeNull();
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('exchanges a cold-start callback using the persisted PKCE verifier', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT', token_type: 'Bearer', expires_in: 3600 }));

    const controller = new AbortController();
    const first = loginWithPortalOidc(undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());
    // Drain the in-flight waiter's consume_pending call (null) so it doesn't
    // also grab the cold-start URL we hand to resume next.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const authorizeUrl = new URL(openUrl.mock.calls[0]?.[0] as string);
    const state = authorizeUrl.searchParams.get('state') ?? '';

    invoke.mockResolvedValue(`${OIDC_REDIRECT_URI}?code=cold-code&state=${state}`);
    await expect(resumePendingOidcLogin()).resolves.toMatchObject({ accessToken: 'AT' });

    const body = new URLSearchParams(httpFetch.mock.calls[0]?.[1].body);
    expect(body.get('code')).toBe('cold-code');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'OidcCancelledError' });
  });

  it('resumes from a persisted callback URL when Rust consume is empty after a reload', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const controller = new AbortController();
    const first = loginWithPortalOidc(undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const authorizeUrl = new URL(openUrl.mock.calls[0]?.[0] as string);
    const state = authorizeUrl.searchParams.get('state') ?? '';

    invoke.mockResolvedValue(null);
    localStorage.setItem('cihub.oidc.callback', `${OIDC_REDIRECT_URI}?code=reloaded&state=${state}`);
    await expect(resumePendingOidcLogin()).resolves.toMatchObject({ accessToken: 'AT' });

    const body = new URLSearchParams(httpFetch.mock.calls[0]?.[1].body);
    expect(body.get('code')).toBe('reloaded');

    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'OidcCancelledError' });
  });

  it('ignores a leftover callback whose state does not match the current attempt', async () => {
    const controller = new AbortController();
    const first = loginWithPortalOidc(undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    invoke.mockResolvedValue(`${OIDC_REDIRECT_URI}?code=stolen&state=tampered`);
    await expect(resumePendingOidcLogin()).resolves.toBeNull();
    expect(httpFetch).not.toHaveBeenCalled();

    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'OidcCancelledError' });
  });

  it('keeps waiting when a leftover callback arrives before the matching one', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ access_token: 'AT' }));
    const promise = loginWithPortalOidc();
    await vi.waitFor(() => expect(anyListener()).toBeTruthy());
    const authorizeUrl = new URL(openUrl.mock.calls[0]?.[0] as string);
    const state = authorizeUrl.searchParams.get('state') ?? '';

    anyListener()?.({ payload: `${OIDC_REDIRECT_URI}?code=stale&state=old-attempt` });
    expect(httpFetch).not.toHaveBeenCalled();

    anyListener()?.({ payload: `${OIDC_REDIRECT_URI}?code=fresh&state=${state}` });
    await expect(promise).resolves.toMatchObject({ accessToken: 'AT' });
    const body = new URLSearchParams(httpFetch.mock.calls[0]?.[1].body);
    expect(body.get('code')).toBe('fresh');
  });
});

describe('emailFromIdToken', () => {
  function tokenWithPayload(payload: unknown): string {
    const json = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `hdr.${json}.sig`;
  }

  it('reads the Portal email from an id_token payload', () => {
    expect(emailFromIdToken(tokenWithPayload({ email: 'user@example.com' }))).toBe('user@example.com');
  });

  it('returns null for missing, empty, or unreadable tokens', () => {
    expect(emailFromIdToken(null)).toBeNull();
    expect(emailFromIdToken('not-a-jwt')).toBeNull();
    expect(emailFromIdToken(tokenWithPayload({ sub: 'user-1' }))).toBeNull();
  });
});
