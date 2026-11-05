/**
 * Sign the desktop app in to Companion Account from the app itself.
 *
 * The app runs the Portal's authorization-code flow with PKCE S256 and a loopback redirect on
 * 127.0.0.1, through the vendored native sign-in runtime. It opens the authorize URL in the system
 * browser and exchanges the code at Portal as the public client `ci-hub`, with no secret. It then
 * sends the Portal access token to this Hub in an Authorization header, and the Hub answers with its
 * own session id, which goes to the keychain (desktop-session.ts). No token goes into a URL.
 */
import { createTauriSignInDriver, runSignIn, type InvokeFn } from '@/vendor/ci-common/native/index';
import { apiFetch, setTauriSessionId } from '@/lib/api-fetch';
import { DESKTOP_PORTAL_CLIENT_ID, desktopSecureStore } from '@/lib/desktop-session';
import { openAuthInSystemBrowser } from '@/lib/helpers/open-auth-browser';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';

/** `email` is what admits the account: the Hub refuses an address Portal has not verified. */
const DESKTOP_PORTAL_SCOPES = ['openid', 'email', 'profile'] as const;

export class DesktopSignInError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'DesktopSignInError';
    this.status = status;
  }
}

/** The Portal origin the Hub checks tokens against, as the Hub itself is configured. */
async function fetchDesktopPortalUrl(): Promise<string> {
  const res = await apiFetch('/api/auth/portal/desktop-config');
  if (!res.ok) {
    throw new DesktopSignInError('This Hub has no Portal to sign in with.', res.status);
  }
  const body = (await res.json()) as { portalUrl?: string | null };
  const portalUrl = body.portalUrl?.trim();
  if (!portalUrl) {
    throw new DesktopSignInError('This Hub has no Portal to sign in with.');
  }
  return portalUrl;
}

/**
 * Run the desktop sign-in and make this window's session the Hub session that comes back.
 * Resolves with the path to open next. Rejects with SignInCancelledError when the person cancels.
 */
export async function signInDesktopWithPortal(options: { signal?: AbortSignal } = {}): Promise<{ redirectPath: string }> {
  const invoke = getTauriInvoke();
  const store = desktopSecureStore();
  if (!invoke || !store) {
    throw new DesktopSignInError('Signing in to the Portal needs the desktop app.');
  }

  const portalUrl = await fetchDesktopPortalUrl();
  const session = await runSignIn({
    config: { clientId: DESKTOP_PORTAL_CLIENT_ID, issuer: portalUrl, scopes: DESKTOP_PORTAL_SCOPES },
    driver: createTauriSignInDriver({ invoke: invoke as InvokeFn, openUrl: openAuthInSystemBrowser }),
    store,
    signal: options.signal,
  });

  const res = await apiFetch('/api/auth/portal/desktop-session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  if (!res.ok) {
    throw new DesktopSignInError(`The Hub did not accept the Portal sign-in (${res.status}).`, res.status);
  }
  const body = (await res.json()) as { sessionId: string; redirectPath?: string };
  setTauriSessionId(body.sessionId);
  return { redirectPath: body.redirectPath || '/home' };
}
