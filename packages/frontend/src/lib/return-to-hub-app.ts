/**
 * Getting back into the Hub's phone app after a flow it handed to the system browser.
 *
 * Connect Memory from the phone app opens Chrome (the consent has to happen on a real browser
 * origin), and without this the flow ended there, on the app's own web page. Instead the phone
 * app asks for the flow to end on {@link RETURN_TO_APP_PATH}, a Hub page in that browser whose
 * main button is a `cihub://intent/app?urn=…` link: Android hands it to the Hub app, and the
 * app's intent handler (`app-intents.ts`) opens that app's page.
 */

/** The Hub page a phone-started connect ends on. Same origin as the Hub, so `next` checks allow it. */
export const RETURN_TO_APP_PATH = '/memory-connect/return-to-app';

/** An app id shaped like `<name>:<store>`, and nothing else a link could carry. */
const APP_URN_PATTERN = /^[A-Za-z0-9][\w.-]*:[\w.-]+$/;

export function isAppUrnLike(value: string | null | undefined): value is string {
  return typeof value === 'string' && APP_URN_PATTERN.test(value);
}

/**
 * The `next` a phone-started connect passes, on the launcher's own origin (the one the browser
 * holds the Hub session for), or null when either part is unusable.
 */
export function returnToAppNext(launcher: string, appUrn: string): string | null {
  if (!isAppUrnLike(appUrn)) {
    return null;
  }
  try {
    const url = new URL(RETURN_TO_APP_PATH, new URL(launcher).origin);
    url.searchParams.set('app', appUrn);
    return url.toString();
  } catch {
    return null;
  }
}

/** The deep link that brings the Hub app forward on `appUrn`'s page. */
export function hubAppDeepLink(appUrn: string): string {
  return `cihub://intent/app?urn=${encodeURIComponent(appUrn)}`;
}

/** Whether a finishing-page target is the return page (so it should not say "Opening <app>…"). */
export function isReturnToAppTarget(target: string | null, currentOrigin: string): boolean {
  if (!target) {
    return false;
  }
  try {
    const url = new URL(target, currentOrigin);
    return url.origin === currentOrigin && url.pathname === RETURN_TO_APP_PATH;
  } catch {
    return false;
  }
}
