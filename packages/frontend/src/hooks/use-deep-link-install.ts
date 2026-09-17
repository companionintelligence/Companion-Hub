import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  buildInstallIntentPath,
  DEFAULT_INSTALL_STORE_ID,
  type InstallIntent,
  stashPendingInstallIntent,
  takePendingInstallIntentFromDesktop,
} from '@/lib/deep-link-install';

const SETUP_ROUTE_PREFIXES = ['/device-registration', '/onboarding', '/restore-apps', '/login', '/register'];

function canNavigateToInstallNow(pathname: string): boolean {
  return !SETUP_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function normalizePayload(payload: InstallIntent): InstallIntent | null {
  const appSlug = payload.appSlug?.trim();
  if (!appSlug) {
    return null;
  }

  return {
    appSlug,
    storeId: payload.storeId?.trim() || DEFAULT_INSTALL_STORE_ID,
    deviceId: payload.deviceId?.trim() || null,
  };
}

/**
 * Captures store install intents from Tauri deep links and routes to the app page.
 */
export function useDeepLinkInstall() {
  const navigate = useNavigate();

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      return;
    }

    let unlisten: (() => void) | undefined;

    /** Returns whether it opened the app's page, rather than holding the link until setup ends. */
    const routeInstallIntent = (raw: InstallIntent): boolean => {
      const intent = normalizePayload(raw);
      if (!intent) {
        return false;
      }

      stashPendingInstallIntent(intent);

      if (!canNavigateToInstallNow(window.location.pathname)) {
        return false;
      }

      void navigate(buildInstallIntentPath(intent), { replace: false });
      return true;
    };

    void (async () => {
      try {
        const pending = await takePendingInstallIntentFromDesktop();
        if (pending) {
          routeInstallIntent(pending);
        }
      } catch {
        // Non-desktop contexts.
      }

      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<InstallIntent>('deep-link-install', (event) => {
          if (routeInstallIntent(event.payload)) {
            // The shell parks every link for a page that is not listening yet, as well as emitting it.
            // This page was listening and has opened the app, so empty that slot, or the next page load
            // takes the same link and opens the install dialog again. A link held during setup stays
            // parked, so the page load that ends setup still opens it.
            void takePendingInstallIntentFromDesktop();
          }
        });
      } catch {
        // Non-desktop contexts.
      }
    })();

    return () => {
      void unlisten?.();
    };
  }, [navigate]);
}
