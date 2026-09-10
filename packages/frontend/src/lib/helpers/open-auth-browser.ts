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
    const opener = await import('@tauri-apps/plugin-opener');
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
