/**
 * OIDC (PKCE) login to the CI cloud Portal for the mobile app.
 *
 * The Portal (better-auth `oidcProvider`) registers a first-party public client
 * `ci-hub` with PKCE required and the custom-scheme redirect `cihub://auth/callback`.
 * On mobile we run the Authorization Code + PKCE flow in an in-app browser and
 * capture the redirect back into the app via the `cihub://` deep link:
 *
 *   1. build {portal}/api/auth/oauth2/authorize?... and open it in the browser
 *   2. user signs in / consents on the Portal
 *   3. Portal redirects to cihub://auth/callback?code=…&state=… (deep link)
 *   4. exchange the code at {portal}/api/auth/oauth2/token (with the PKCE verifier)
 *
 * Token exchange goes through the Tauri HTTP plugin (native, no webview CORS).
 */
import { AuthSessionCancelledError, openAuthSession } from '@/lib/helpers/open-auth-browser';
import { DEFAULT_PORTAL_URL } from './portal-client';

export const OIDC_CLIENT_ID = 'ci-hub';
export const OIDC_REDIRECT_URI = 'cihub://auth/callback';
const OIDC_SCOPE = 'openid email profile';
/** Survives an iOS kill between Safari login and "Open with Companion Hub". */
const OIDC_PENDING_KEY = 'cihub.oidc.pending';
const OIDC_CALLBACK_KEY = 'cihub.oidc.callback';
const OIDC_PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export interface OidcTokens {
  accessToken: string;
  idToken: string | null;
  tokenType: string;
  expiresIn: number | null;
}

/** Read `email` from an OIDC id_token payload. Display-only — not a signature check. */
export function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(padded)) as { email?: unknown };
    return typeof json.email === 'string' && json.email.trim() ? json.email.trim() : null;
  } catch {
    return null;
  }
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
  try {
    const http = await import('@tauri-apps/plugin-http');
    if (typeof http.fetch === 'function') {
      return http.fetch as unknown as typeof fetch;
    }
  } catch {
    // ios:dev often has no Tauri HTTP IPC — fall through to window.fetch.
  }
  return globalThis.fetch.bind(globalThis);
}

interface PendingOidc {
  verifier: string;
  state: string;
  portal: string;
  startedAt: number;
}

function persistPendingOidc(pending: PendingOidc): void {
  try {
    const raw = JSON.stringify(pending);
    sessionStorage.setItem(OIDC_PENDING_KEY, raw);
    localStorage.setItem(OIDC_PENDING_KEY, raw);
  } catch {
    // Private mode / quota — warm-resume via the live listener may still work.
  }
}

function readPendingOidc(): PendingOidc | null {
  try {
    const raw = sessionStorage.getItem(OIDC_PENDING_KEY) ?? localStorage.getItem(OIDC_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingOidc;
    if (!parsed.verifier || !parsed.state || !parsed.portal || !parsed.startedAt) return null;
    if (Date.now() - parsed.startedAt > OIDC_PENDING_MAX_AGE_MS) {
      clearPendingOidc();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function clearPendingOidc(): Promise<void> {
  try {
    sessionStorage.removeItem(OIDC_PENDING_KEY);
    localStorage.removeItem(OIDC_PENDING_KEY);
    sessionStorage.removeItem(OIDC_CALLBACK_KEY);
    localStorage.removeItem(OIDC_CALLBACK_KEY);
  } catch {
    /* ignore */
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('clear_pending_oidc_callback');
  } catch {
    /* not running under Tauri */
  }
}

function persistOidcCallbackUrl(url: string): void {
  try {
    sessionStorage.setItem(OIDC_CALLBACK_KEY, url);
    localStorage.setItem(OIDC_CALLBACK_KEY, url);
  } catch {
    /* ignore */
  }
}

function readPersistedOidcCallbackUrl(): string | null {
  try {
    return sessionStorage.getItem(OIDC_CALLBACK_KEY) ?? localStorage.getItem(OIDC_CALLBACK_KEY);
  } catch {
    return null;
  }
}

function parseOidcCallback(url: string, expectedState?: string): { code: string } | { error: Error } | null {
  if (!url.startsWith('cihub://auth/callback')) return null;
  const query = url.split('?')[1] ?? '';
  const params = new URLSearchParams(query);
  const error = params.get('error');
  if (error) {
    return { error: new Error(params.get('error_description') || error) };
  }
  const code = params.get('code');
  const state = params.get('state');
  if (!code) return null;
  if (expectedState !== undefined && state !== expectedState) {
    // Leftover callback from a previous Safari hop — ignore, keep waiting.
    return null;
  }
  return { code };
}

/** Pull a callback URL that arrived before JS was listening (iOS cold start). */
async function takePendingOidcCallbackUrl(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const pending = await invoke<string | null>('consume_pending_oidc_callback');
    if (pending?.startsWith('cihub://auth/callback')) {
      persistOidcCallbackUrl(pending);
      return pending;
    }
  } catch {
    // Not running under Tauri, or the command is from an older binary.
  }
  const stored = readPersistedOidcCallbackUrl();
  if (stored?.startsWith('cihub://auth/callback')) return stored;
  if (typeof window !== 'undefined' && window.location.href.startsWith('cihub://auth/callback')) {
    persistOidcCallbackUrl(window.location.href);
    return window.location.href;
  }
  return null;
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
 *
 * Desktop delivers it on `deep-link://new-url`. iOS does not — the Rust shell
 * emits `deep-link-oidc` from `on_open_url` instead. We listen to both, and
 * also drain a stashed / already-open URL so a cold start from
 * "Open with Companion Hub" still completes.
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
      const parsed = parseOidcCallback(url, expectedState);
      if (!parsed) return;
      persistOidcCallbackUrl(url);
      cleanup();
      if ('error' in parsed) {
        reject(parsed.error);
        return;
      }
      resolve(parsed);
    };

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlistens: Array<() => void> = [];
        for (const name of ['deep-link://new-url', 'deep-link-oidc'] as const) {
          unlistens.push(
            await listen<string | string[]>(name, (event) => {
              const urls = Array.isArray(event.payload) ? event.payload : [event.payload];
              for (const u of urls) handle(u);
            }),
          );
        }
        unlisten = () => {
          for (const stop of unlistens) stop();
        };
        // If we were aborted while the async listener was being registered, drop it.
        if (signal?.aborted) {
          unlisten();
          return;
        }
        const already = await takePendingOidcCallbackUrl();
        if (already) handle(already);
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

/** Authorization codes are single-use. Safari + resume both try the same code. */
const exchangeByCode = new Map<string, Promise<OidcTokens>>();

async function exchangeCodeOnce(portal: string, code: string, codeVerifier: string): Promise<OidcTokens> {
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

async function exchangeCode(portal: string, code: string, codeVerifier: string): Promise<OidcTokens> {
  const existing = exchangeByCode.get(code);
  if (existing) return existing;
  const pending = exchangeCodeOnce(portal, code, codeVerifier).catch((err) => {
    exchangeByCode.delete(code);
    throw err;
  });
  exchangeByCode.set(code, pending);
  return pending;
}

/**
 * Run the full OIDC PKCE login against the Portal. On iOS the Portal page is an
 * in-app authentication sheet (iOS Safari session, Android Auth Tab); desktop
 * uses the system browser. Resolves once
 * the user finishes and the `cihub://auth/callback` deep link is captured and
 * exchanged for tokens.
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

  // Persist PKCE *before* the sheet / browser opens — iOS often kills the
  // webview while the user is on the Portal, then cold-starts us from the callback.
  // Drop a leftover `cihub://` from the last attempt *before* we listen, or
  // takePendingOidcCallbackUrl() poisons this waiter with the old state.
  await clearPendingOidc();
  exchangeByCode.clear();
  persistPendingOidc({ verifier: codeVerifier, state, portal, startedAt: Date.now() });

  // `addEventListener` does not fire for a signal that is already aborted, and
  // opening the sheet after the caller has given up is pointless.
  if (options.signal?.aborted) {
    await clearPendingOidc();
    throw new OidcCancelledError();
  }

  const abortOnDismiss = new AbortController();
  const onCallerAbort = () => abortOnDismiss.abort();
  options.signal?.addEventListener('abort', onCallerAbort);
  const callback = awaitOidcCallback(state, abortOnDismiss.signal);

  try {
    await openAuthSession(authorizeUrl.toString());
  } catch (err) {
    abortOnDismiss.abort();
    options.signal?.removeEventListener('abort', onCallerAbort);
    await callback.catch(() => undefined);

    if (err instanceof AuthSessionCancelledError) {
      await clearPendingOidc();
      throw new OidcCancelledError();
    }

    throw err;
  }

  try {
    const { code } = await callback;
    const tokens = await exchangeCode(portal, code, codeVerifier);
    await clearPendingOidc();
    return tokens;
  } catch (err) {
    if (err instanceof OidcCancelledError) await clearPendingOidc();
    throw err;
  } finally {
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Finish an OIDC login after iOS relaunched the app from
 * `cihub://auth/callback` (Safari → "Open with Companion Hub").
 * Returns `null` when there is nothing to resume.
 */
export async function resumePendingOidcLogin(): Promise<OidcTokens | null> {
  const pending = readPendingOidc();
  if (!pending) return null;
  const url = await takePendingOidcCallbackUrl();
  if (!url) return null;
  const parsed = parseOidcCallback(url, pending.state);
  if (!parsed) return null;
  if ('error' in parsed) {
    await clearPendingOidc();
    throw parsed.error;
  }
  const tokens = await exchangeCode(pending.portal, parsed.code, pending.verifier);
  await clearPendingOidc();
  return tokens;
}
