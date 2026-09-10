import { retryDynamicImport } from '@/lib/chunk-load-error';

/**
 * Open an auth URL in the real system browser (Safari / Chrome Custom Tabs).
 *
 * Used by every native shell:
 *  - cloud-connect PKCE on `/connect` (`oidc.ts`), iOS/Android
 *  - Hub Companion Account SSO on `/login` (`mobile-hub-sso`)
 *  - Hub Companion Account SSO on `/login` (`desktop-hub-sso`)
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
    // retryDynamicImport for the same reason open-external.ts uses it: this is
    // the sign-in path on every native shell, so a stale chunk hash here is the
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
