/**
 * The desktop app's Hub session, kept in the OS keychain.
 *
 * The session id is a bearer credential for this Hub. It lives where the OS protects secrets
 * (tauri-plugin-ci-auth: Keychain on macOS, Credential Manager on Windows, Secret Service on Linux),
 * not in the WebView's localStorage, which any script on the page can read. apiFetch sends the
 * in-memory copy, which is loaded from the keychain once at startup, before the first request.
 *
 * The Portal refresh token that the native sign-in keeps is in the same keychain, under the key
 * the native runtime derives for the `ci-hub` client. Signing out removes both.
 */
import { createTauriSecureStore, refreshTokenKey, type InvokeFn, type SecureStore } from '@/vendor/ci-common/native/index';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';

/** The keychain entry that holds this desktop's Hub session id. */
export const DESKTOP_SESSION_KEY = 'ci.hub.session';

/** The public client the desktop signs in as at Portal. No secret. */
export const DESKTOP_PORTAL_CLIENT_ID = 'ci-hub';

/**
 * The keychain behind the Tauri shell, or null in a plain browser. A null store means there is no
 * keychain to write to, so callers keep the session in memory only.
 */
export function desktopSecureStore(): SecureStore | null {
  const invoke = getTauriInvoke();
  if (!invoke) {
    return null;
  }
  return createTauriSecureStore({ invoke: invoke as InvokeFn });
}

/** The Hub session id from the keychain, or null when none is stored. Throws when the keychain refuses. */
export function readDesktopSessionId(store: SecureStore): Promise<string | null> {
  return store.get(DESKTOP_SESSION_KEY);
}

export function writeDesktopSessionId(store: SecureStore, sessionId: string): Promise<void> {
  return store.set(DESKTOP_SESSION_KEY, sessionId);
}

/** Forget this desktop's Hub session and the Portal refresh token. Both removals resolve when nothing is stored. */
export async function removeDesktopSession(store: SecureStore): Promise<void> {
  await store.remove(DESKTOP_SESSION_KEY);
  await store.remove(refreshTokenKey(DESKTOP_PORTAL_CLIENT_ID));
}
