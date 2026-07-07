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

    const routeInstallIntent = (raw: InstallIntent) => {
      const intent = normalizePayload(raw);
      if (!intent) {
        return;
      }

      stashPendingInstallIntent(intent);

      if (!canNavigateToInstallNow(window.location.pathname)) {
        return;
      }

      void navigate(buildInstallIntentPath(intent), { replace: false });
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
          routeInstallIntent(event.payload);
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
