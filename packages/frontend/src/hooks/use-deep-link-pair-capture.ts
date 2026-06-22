import { useEffect } from 'react';
import { normalizePairingCode, stashPendingPairingCode } from '@/lib/deep-link-pair';

/**
 * Captures pairing codes from Tauri deep links as early as possible.
 * HubStatus mounts before the registration route, so we stash codes until
 * the device registration screen can consume them.
 */
export function useDeepLinkPairCapture() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      return;
    }

    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<string>('deep-link-pair', (event) => {
          const code = normalizePairingCode(event.payload);
          if (code) {
            stashPendingPairingCode(code);
          }
        });
      } catch {
        // Non-desktop contexts.
      }
    })();

    return () => {
      void unlisten?.();
    };
  }, []);
}
