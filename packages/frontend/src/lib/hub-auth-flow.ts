import { isTauriDesktopApp } from '@/lib/hub-runtime-mode';
import { getHubBaseUrlSync, usesCloudConnect } from '@/lib/mobile-connection';

/**
 * How this client signs into Companion Account / a Hub.
 *
 * Do not mix these. Every SSO bug we hit traced to starting one flow and
 * finishing another (PKCE callback vs Hub token, :5005 vs :5002, Safari vs <a>).
 *
 *  - `mobile-cloud-connect` — iOS/Android `/connect` only. Portal PKCE
 *    (`oidc.ts`, `cihub://auth/callback`, `deep-link-oidc`), then pick a Hub.
 *    iOS opens the Portal in an in-app sheet (`openAuthSession`).
 *  - `mobile-hub-sso` — iOS/Android `/login` after a Hub is chosen. Remote Hub
 *    `/api/auth/portal/start?desktop=1` via `openAuthSession` (iOS sheet,
 *    Android Auth Tab) → `cihub://auth?token=` → `deep-link-auth` /
 *    desktop-exchange on that Hub.
 *  - `desktop-hub-sso` — Mac / Linux / Windows Tauri while a Hub is running.
 *    The app runs its own PKCE sign-in over a 127.0.0.1 loopback redirect
 *    (desktop-portal-sign-in.ts): the system browser opens Portal, the app
 *    exchanges the code, and the Hub mints its session from the access token in
 *    a header. No token goes into a deep link.
 *  - `browser-hub-sso` — any browser on a Hub (including a phone browser).
 *    Same-origin `/portal/start` with no `desktop=1`; cookie session.
 */
export type HubAuthFlow = 'mobile-cloud-connect' | 'mobile-hub-sso' | 'desktop-hub-sso' | 'browser-hub-sso';

export interface HubAuthFlowInput {
  usesCloudConnect: boolean;
  remoteHubUrl?: string | null;
  isTauriDesktop: boolean;
}

export function resolveHubAuthFlow(input: HubAuthFlowInput): HubAuthFlow {
  if (input.usesCloudConnect) {
    return input.remoteHubUrl?.trim() ? 'mobile-hub-sso' : 'mobile-cloud-connect';
  }
  if (input.isTauriDesktop) {
    return 'desktop-hub-sso';
  }
  return 'browser-hub-sso';
}

/** Live document — call at use-time, not module init. */
export function readHubAuthFlow(): HubAuthFlow {
  return resolveHubAuthFlow({
    usesCloudConnect: usesCloudConnect(),
    remoteHubUrl: getHubBaseUrlSync(),
    isTauriDesktop: isTauriDesktopApp(),
  });
}

export interface HubAuthFlowPolicy {
  /** Portal PKCE on `/connect`. Never Mac/Linux/Windows. */
  usesPortalPkce: boolean;
  /** Companion Account button on `/login` (`/api/auth/portal/start`). */
  usesHubPortalSso: boolean;
  /**
   * A phone's Hub SSO finishes with a one-time token on `cihub://`. The desktop does not: it signs in
   * itself (desktop-portal-sign-in), so no token goes into a deep link on Mac, Linux or Windows.
   */
  usesDeepLinkHandoff: boolean;
  /**
   * Native Hub SSO must keep its own webview mounted (button + `openAuthSession`).
   *
   * True for iOS/Android AND for Mac/Linux/Windows. Phones finish through
   * `cihub://auth?token=`, and the only code that exchanges that token —
   * `useDesktopPortalAuth` — lives in this React app. Navigating the app's own
   * webview to `/portal/start` unmounts it, so the token arrives with nobody
   * listening. iOS presents an in-app Safari sheet and Android presents Chrome
   * Auth Tab. Desktop opens the system browser for its own PKCE sign-in, and no
   * token comes back through a link. The authorization request
   * belongs in browser chrome on its own terms: RFC 8252, plus passkeys, password managers and an address
   * bar the user can check before typing a Companion Account password.
   */
  openHubSsoInSystemBrowser: boolean;
  /** Switch-Hub control — only after a remote Hub was chosen. */
  showSwitchHub: boolean;
  /** Listen for `deep-link-auth` (a phone's Hub token). Not the PKCE `deep-link-oidc`. */
  listenDeepLinkAuth: boolean;
  /**
   * Retired: the desktop no longer heartbeats to the Hub, so a browser sign-in on loopback does not hand
   * off into it. Older desktop builds still announce, and the Hub keeps answering them until they age out.
   */
  announceDesktopPresence: boolean;
}

export function hubAuthFlowPolicy(flow: HubAuthFlow): HubAuthFlowPolicy {
  return {
    usesPortalPkce: flow === 'mobile-cloud-connect',
    usesHubPortalSso: flow !== 'mobile-cloud-connect',
    usesDeepLinkHandoff: flow === 'mobile-hub-sso',
    openHubSsoInSystemBrowser: flow === 'mobile-hub-sso' || flow === 'desktop-hub-sso',
    showSwitchHub: flow === 'mobile-hub-sso',
    listenDeepLinkAuth: flow === 'mobile-hub-sso',
    announceDesktopPresence: false,
  };
}
