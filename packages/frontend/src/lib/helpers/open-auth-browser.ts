import { retryDynamicImport } from '@/lib/chunk-load-error';

/**
 * Open an auth URL in the real system browser.
 *
 * Used by the desktop shell. Phone sign-in goes through {@link openAuthSession}
 * and does not call this.
 *
 * Desktop calls this from an onClick, NOT from an `<a href>`: an anchor whose
 * href is same-origin with the packaged shell is left alone by the Providers
 * interceptor, so it navigates the app's own webview and unmounts the listener
 * that finishes the login. Do not use `window.open` on a phone: WKWebView treats
 * it as same-document navigation and then follows `cihub://` into a permanent
 * black screen.
 */
export async function openAuthInSystemBrowser(url: string): Promise<void> {
  let openUrl: ((href: string) => Promise<void>) | undefined;
  try {
    // retryDynamicImport for the same reason open-external.ts uses it: desktop
    // sign-in still imports this plugin, so a stale chunk hash here is the
    // difference between a browser opening and a button that does nothing.
    const opener = await retryDynamicImport(() => import('@tauri-apps/plugin-opener'));
    openUrl = opener.openUrl;
  } catch {
    openUrl = undefined;
  }
  if (openUrl) {
    // Do not swallow ACL / plugin errors — a silent <a> fallback on iOS
    // leaves Sign in spinning with no Safari window.
    await openUrl(url);
    return;
  }

  // NO SILENT FALLBACK INSIDE A WEBVIEW.
  //
  // The <a target="_blank"> below is for a real web context. In wry it is inert
  // and in WKWebView it is a same-document navigation, so falling through there
  // turns a failed import into a dead button with nothing in the console — the
  // exact silent-failure shape this file's callers were fixed for. Reject
  // instead and let the caller surface it.
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    throw new Error('The system opener is unavailable, so sign-in could not open a browser.');
  }

  if (typeof document === 'undefined') {
    throw new Error('Could not open the system browser for sign-in.');
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** User dismissed the in-app sign-in sheet. Callers should stay quiet. */
export class AuthSessionCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'AuthSessionCancelledError';
  }
}

function isAuthSessionCancel(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { code?: unknown; message?: unknown };
  if (rec.code === 'CANCELLED') return true;
  return typeof rec.message === 'string' && rec.message === 'Sign-in cancelled';
}

function isTauriShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** iPhone / iPad / iPod, including iPad "Request Desktop Website". */
function isIosPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  if (/iphone|ipad|ipod/i.test(navigator.platform || '')) return true;
  return /macintosh/i.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
}

function isAndroidPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android/i.test(navigator.userAgent || '');
}

/**
 * Sign-in / registration in an in-app sheet.
 * iOS uses `ASWebAuthenticationSession`. Android uses Chrome Auth Tab, which
 * falls back to a Custom Tab on older browsers. The sheet returns `cihub://`
 * to the app, which the existing deep-link listener finishes. Desktop and web
 * keep opening the system browser.
 */
export async function openAuthSession(url: string, callbackScheme = 'cihub'): Promise<void> {
  if (!isTauriShell() || (!isIosPlatform() && !isAndroidPlatform())) {
    await openAuthInSystemBrowser(url);
    return;
  }

  try {
    const { invoke } = await retryDynamicImport(() => import('@tauri-apps/api/core'));
    await invoke('start_auth_session', { url, callbackScheme });
  } catch (err: unknown) {
    if (isAuthSessionCancel(err)) {
      throw new AuthSessionCancelledError();
    }

    throw err;
  }
}
