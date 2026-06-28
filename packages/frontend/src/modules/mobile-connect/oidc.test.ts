import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loginWithPortalOidc, OIDC_CLIENT_ID, OIDC_REDIRECT_URI } from './oidc';
import { DEFAULT_PORTAL_URL } from './portal-client';

const openUrl = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (...a: unknown[]) => openUrl(...a) }));

const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => httpFetch(...a) }));

// Capture the deep-link handler the flow registers so the test can fire the callback.
let deepLinkHandler: ((event: { payload: string | string[] }) => void) | null = null;
const unlisten = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, cb: (e: { payload: string | string[] }) => void) => {
    deepLinkHandler = cb;
    return unlisten;
  }),
}));

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  openUrl.mockClear();
  httpFetch.mockReset();
  unlisten.mockClear();
  deepLinkHandler = null;
});

/** Drive the flow: wait for the authorize URL + listener, then fire the callback. */
async function fireCallback(code: string, stateOverride?: string) {
  await vi.waitFor(() => {
    expect(openUrl).toHaveBeenCalled();
    expect(deepLinkHandler).toBeTruthy();
  });
  const authorizeUrl = new URL(openUrl.mock.calls[0]![0] as string);
  const state = stateOverride ?? authorizeUrl.searchParams.get('state') ?? '';
  deepLinkHandler?.({ payload: `${OIDC_REDIRECT_URI}?code=${code}&state=${state}` });
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
    const [tokenUrl, init] = httpFetch.mock.calls[0]!;
    expect(tokenUrl).toBe(`${DEFAULT_PORTAL_URL}/api/auth/oauth2/token`);
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(unlisten).toHaveBeenCalled(); // listener cleaned up
  });

  it('rejects when the callback state does not match (CSRF guard)', async () => {
    const promise = loginWithPortalOidc();
    await fireCallback('code', 'tampered-state');
    await expect(promise).rejects.toThrow(/state mismatch/i);
  });

  it('surfaces a token-exchange failure', async () => {
    httpFetch.mockResolvedValue(tokenResponse({ error_description: 'bad verifier' }, 400));
    const promise = loginWithPortalOidc();
    await fireCallback('code');
    await expect(promise).rejects.toThrow('bad verifier');
  });
});
