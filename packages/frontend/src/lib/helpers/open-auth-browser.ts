/**
 * Open an auth URL in the real system browser (Safari / Chrome Custom Tabs).
 *
 * Used only by iOS/Android:
 *  - cloud-connect PKCE on `/connect` (`oidc.ts`)
 *  - Hub Companion Account SSO on `/login` (`mobile-hub-sso`)
 *
 * Mac / Linux / Windows desktop must use a normal `<a href>` instead — calling
 * this from desktop opens a second tab. Do not use `window.open` on a phone:
 * WKWebView treats it as same-document navigation and then follows `cihub://`
 * into a permanent black screen.
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
