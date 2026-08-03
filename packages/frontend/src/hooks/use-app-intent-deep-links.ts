import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { type IntentAction, loadKnownHubs, parseIntentAction, resolveIntentNavigation, takePendingIntent } from '@/lib/app-intents';
import { isTauriMobileSync } from '@/lib/mobile-connection';

/**
 * Routes iOS App Intents (Siri / Shortcuts / Spotlight / Action Button) to the
 * right screen. The native intent opens a `cihub://intent/<action>` deep link;
 * the Rust shell stashes it (cold start) and emits `deep-link-intent`. This
 * hook drains the pending action on mount and listens for live ones, then
 * navigates — re-pointing at a different Hub with a hard reload when needed.
 *
 * Mounted high in the app shell (HubStatus) so it works from any screen.
 * Inert off mobile.
 */
export function useAppIntentDeepLinks() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isTauriMobileSync()) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const run = async (action: IntentAction | null) => {
      if (!action || cancelled) return;
      const hubs = await loadKnownHubs();
      const { path, reload } = await resolveIntentNavigation(action, hubs);
      if (cancelled) return;
      if (reload) {
        window.location.assign(path);
      } else {
        navigate(path);
      }
    };

    void (async () => {
      // Cold start: an intent may have launched the app before this mounted.
      await run(await takePendingIntent());
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<string>('deep-link-intent', (event) => {
          void run(parseIntentAction(event.payload));
        });
        // If we were torn down while registering, drop the dangling listener.
        if (cancelled) unlisten?.();
      } catch {
        // Non-mobile context / no event API — nothing to route.
      }
    })();

    return () => {
      cancelled = true;
      void unlisten?.();
    };
  }, [navigate]);
}
