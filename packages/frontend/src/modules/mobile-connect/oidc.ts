/**
 * OIDC (PKCE) login to the CI cloud Portal for the mobile app.
 *
 * The Portal (better-auth `oidcProvider`) registers a first-party public client
 * `ci-hub` with PKCE required and the custom-scheme redirect `cihub://auth/callback`.
 * On mobile we run the Authorization Code + PKCE flow in the system browser and
 * capture the redirect back into the app via the `cihub://` deep link:
 *
 *   1. build {portal}/api/auth/oauth2/authorize?... and open it in the browser
 *   2. user signs in / consents on the Portal
 *   3. Portal redirects to cihub://auth/callback?code=…&state=… (deep link)
 *   4. exchange the code at {portal}/api/auth/oauth2/token (with the PKCE verifier)
 *
 * Token exchange goes through the Tauri HTTP plugin (native, no webview CORS).
 */
import { DEFAULT_PORTAL_URL } from './portal-client';

export const OIDC_CLIENT_ID = 'ci-hub';
export const OIDC_REDIRECT_URI = 'cihub://auth/callback';
const OIDC_SCOPE = 'openid email profile';

export interface OidcTokens {
  accessToken: string;
  idToken: string | null;
  tokenType: string;
  expiresIn: number | null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 48): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function normalizePortalUrl(url: string): string {
  return url.trim().replace(/\/+$/, '') || DEFAULT_PORTAL_URL;
}

async function nativeFetch(): Promise<typeof fetch> {
  const http = await import('@tauri-apps/plugin-http');
  return http.fetch as unknown as typeof fetch;
}

async function openInSystemBrowser(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/** Thrown when the user cancels the OIDC sign-in (so the UI can stay quiet). */
export class OidcCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'OidcCancelledError';
  }
}

/**
 * Wait for the `cihub://auth/callback?code=…&state=…` deep link.
 * Listens on the deep-link plugin's raw `deep-link://new-url` event (the same
 * event the Rust shell forwards), so no extra native command is required.
 * Rejects with {@link OidcCancelledError} if `signal` aborts (user pressed Cancel).
 */
function awaitOidcCallback(expectedState: string, signal?: AbortSignal, timeoutMs = 300_000): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      unlisten?.();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new OidcCancelledError());
    };
    if (signal?.aborted) {
      reject(new OidcCancelledError());
      return;
    }
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for sign-in to complete.'));
    }, timeoutMs);

    const handle = (url: string) => {
      if (!url.startsWith('cihub://auth/callback')) return;
      const query = url.split('?')[1] ?? '';
      const params = new URLSearchParams(query);
      const error = params.get('error');
      if (error) {
        cleanup();
        reject(new Error(params.get('error_description') || error));
        return;
      }
      const code = params.get('code');
      const state = params.get('state');
      if (!code) return;
      if (state !== expectedState) {
        cleanup();
        reject(new Error('Sign-in state mismatch — please try again.'));
        return;
      }
      cleanup();
      resolve({ code });
    };

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<string | string[]>('deep-link://new-url', (event) => {
        const urls = Array.isArray(event.payload) ? event.payload : [event.payload];
        for (const u of urls) handle(u);
      });
      // If we were aborted while the async listener was being registered, drop it.
      if (signal?.aborted) unlisten?.();
    })();
  });
}

async function exchangeCode(portal: string, code: string, codeVerifier: string): Promise<OidcTokens> {
  const doFetch = await nativeFetch();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OIDC_CLIENT_ID,
    redirect_uri: OIDC_REDIRECT_URI,
    code,
    code_verifier: codeVerifier,
  });
  const res = await doFetch(`${portal}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    // Don't hang forever on a slow/unreachable Portal.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    let message = `Token exchange failed (${res.status})`;
    try {
      const err = (await res.json()) as { error_description?: string; error?: string };
      message = err.error_description || err.error || message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const data = (await res.json()) as {
    access_token: string;
    id_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  return {
    accessToken: data.access_token,
    idToken: data.id_token ?? null,
    tokenType: data.token_type ?? 'Bearer',
    expiresIn: data.expires_in ?? null,
  };
}

/**
 * Run the full OIDC PKCE login against the Portal. Opens the system browser and
 * resolves once the user finishes and the `cihub://auth/callback` deep link is
 * captured and exchanged for tokens.
 */
export async function loginWithPortalOidc(portalUrl = DEFAULT_PORTAL_URL, options: { signal?: AbortSignal } = {}): Promise<OidcTokens> {
  const portal = normalizePortalUrl(portalUrl);
  const codeVerifier = randomString();
  const codeChallenge = await sha256Challenge(codeVerifier);
  const state = randomString(16);

  const authorizeUrl = new URL(`${portal}/api/auth/oauth2/authorize`);
  authorizeUrl.searchParams.set('client_id', OIDC_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', OIDC_REDIRECT_URI);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', OIDC_SCOPE);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', state);

  // Start listening BEFORE opening the browser so we never miss the redirect.
  const callback = awaitOidcCallback(state, options.signal);
  await openInSystemBrowser(authorizeUrl.toString());
  const { code } = await callback;
  return exchangeCode(portal, code, codeVerifier);
}
