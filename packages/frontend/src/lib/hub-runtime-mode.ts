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
