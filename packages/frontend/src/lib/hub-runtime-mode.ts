import { isTauriMobileSync } from '@/lib/mobile-connection';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';

/** How the Hub frontend is hosted — drives auth, API probing, and i18n fetch behavior. */
export type HubRuntimeMode = 'browser' | 'desktop-same-origin' | 'desktop-embedded' | 'mobile-remote';

export function isLocalTauriDevOrigin(origin = window.location.origin): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * Resolve the current runtime mode from the live document origin.
 *
 * Must be called at use-time (not module init): release desktop navigates from
 * bootstrap (`tauri://`) to stack UI (`http://127.0.0.1:PORT`) after startup.
 */
export function getHubRuntimeMode(): HubRuntimeMode {
  if (typeof window === 'undefined') {
    return 'browser';
  }

  if (!getTauriInvoke()) {
    return 'browser';
  }

  if (isTauriMobileSync()) {
    return 'mobile-remote';
  }

  if (isLocalTauriDevOrigin()) {
    return 'desktop-same-origin';
  }

  return 'desktop-embedded';
}

/** Cross-origin API (tauri:// or mobile → remote https): session header, omit cookies. */
export function usesCrossOriginDesktopApi(): boolean {
  const mode = getHubRuntimeMode();
  return mode === 'desktop-embedded' || mode === 'mobile-remote';
}

/** Same-origin stack UI: cookie session, relative API paths (browser + release desktop). */
export function usesSameOriginHubApi(): boolean {
  const mode = getHubRuntimeMode();
  return mode === 'browser' || mode === 'desktop-same-origin';
}

/**
 * True when this runtime can hold a session that no cookie carries.
 *
 * Cross-origin desktop and mobile never receive one. A same-origin desktop
 * usually does — but not through the portal SSO handoff, which returns its
 * session in the response body and plants no cookie. A browser always has the
 * cookie: `/auth/login` sets it on the same response whose body the login page
 * also stores, so its stored id is a duplicate, never the only copy.
 *
 * Callers that cannot send `X-CI-Hub-Session` (EventSource) use this to decide
 * whether to present the id another way. It stays false for browsers so a live
 * session id never enters a URL for the one runtime that has no need of it.
 */
export function mayHoldCookielessSession(): boolean {
  return getHubRuntimeMode() !== 'browser';
}

/** macOS / Linux / Windows Tauri — not iOS / Android and not a plain browser. */
export function isTauriDesktopApp(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return Boolean(getTauriInvoke()) && !isTauriMobileSync();
}

/** True on the minimal bootstrap splash before navigation to the stack UI. */
export function isDesktopBootstrapPage(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  if (!getTauriInvoke() || isTauriMobileSync()) {
    return false;
  }
  try {
    const { protocol, pathname } = window.location;
    return (
      (protocol === 'tauri:' || (protocol === 'https:' && window.location.hostname === 'tauri.localhost')) &&
      (pathname === '/' || pathname.endsWith('/index.html'))
    );
  } catch {
    return false;
  }
}
