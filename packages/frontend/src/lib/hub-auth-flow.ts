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
 *  - `mobile-hub-sso` — iOS/Android `/login` after a Hub is chosen. Remote Hub
 *    `/api/auth/portal/start?desktop=1` in Safari → `cihub://auth?token=` →
 *    `deep-link-auth` / desktop-exchange on that Hub.
 *  - `desktop-hub-sso` — Mac / Linux / Windows Tauri while a Hub is running.
 *    Same-origin (or probed) Hub `/portal/start?desktop=1` via a normal
 *    `<a href>` → `cihub-dev://` / `cihub://` → desktop-exchange on that Hub.
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
  /** `cihub://` / `cihub-dev://` one-time token after Hub SSO. */
  usesDeepLinkHandoff: boolean;
  /** iOS/Android Hub SSO must keep WKWebView mounted (button + system browser). */
  openHubSsoInSystemBrowser: boolean;
  /** Switch-Hub control — only after a remote Hub was chosen. */
  showSwitchHub: boolean;
  /** Listen for `deep-link-auth` (Hub token). Not the PKCE `deep-link-oidc`. */
  listenDeepLinkAuth: boolean;
  /** Desktop-only heartbeat so a Chrome loopback callback can hand off into Tauri. */
  announceDesktopPresence: boolean;
}

export function hubAuthFlowPolicy(flow: HubAuthFlow): HubAuthFlowPolicy {
  return {
    usesPortalPkce: flow === 'mobile-cloud-connect',
    usesHubPortalSso: flow !== 'mobile-cloud-connect',
    usesDeepLinkHandoff: flow === 'mobile-hub-sso' || flow === 'desktop-hub-sso',
    openHubSsoInSystemBrowser: flow === 'mobile-hub-sso',
    showSwitchHub: flow === 'mobile-hub-sso',
    listenDeepLinkAuth: flow === 'mobile-hub-sso' || flow === 'desktop-hub-sso',
    announceDesktopPresence: flow === 'desktop-hub-sso',
  };
}
