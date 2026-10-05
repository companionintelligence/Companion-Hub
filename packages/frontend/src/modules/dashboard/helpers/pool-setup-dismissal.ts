import { useCallback, useState } from 'react';

/** Dot form, like `ci-hub.onboarding-install`. Per browser origin: the desktop app, a LAN name and the tailnet name each keep their own. */
export const POOL_SETUP_DISMISSED_KEY = 'ci-hub.pool-setup-dismissed';

/**
 * What a dismissal falls back to when storage cannot be used (private windows, blocked site data, a
 * quota error). Only consulted when storage throws on read, so it never overrides a working store.
 */
let dismissedInMemory = false;

/** Whether the user dismissed the Home page's Hub Pool suggestion. Never throws. */
export function readPoolSetupDismissed(): boolean {
  if (typeof window === 'undefined') return dismissedInMemory;
  try {
    return window.localStorage.getItem(POOL_SETUP_DISMISSED_KEY) === '1';
  } catch {
    return dismissedInMemory;
  }
}

/** Records the dismissal. Never throws: in-memory first, so it holds for this page load even if storage refuses. */
export function writePoolSetupDismissed(): void {
  dismissedInMemory = true;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(POOL_SETUP_DISMISSED_KEY, '1');
  } catch {
    // The in-memory flag above already covers this page load.
  }
}

/**
 * The dismissal as React state. Deliberately not cleared on logout (`clearClientHubState`): signing out
 * and back in is not a reason to ask again.
 */
export function usePoolSetupDismissal() {
  const [dismissed, setDismissed] = useState(readPoolSetupDismissed);
  const dismiss = useCallback(() => {
    writePoolSetupDismissed();
    setDismissed(true);
  }, []);
  return { dismissed, dismiss };
}
