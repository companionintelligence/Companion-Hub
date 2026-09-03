import { setTauriSessionId } from './api-fetch';
import { clearRegistrationCache } from './registration-cache';
import { clearStoredDriftChoice } from './registration-state-drift';

const PORTAL_ACCOUNT_EMAIL_KEY = 'ci-hub.portalAccountEmail';

export function clearRememberedPortalAccountEmail(): void {
  try {
    localStorage.removeItem(PORTAL_ACCOUNT_EMAIL_KEY);
  } catch {
    // Storage may be unavailable in some embedded contexts.
  }
}

export type ClearClientHubStateOptions = {
  /** Keep the remembered Portal email hint (useful on logout). */
  keepPortalEmail?: boolean;
};

/** Clear browser-side Hub state so a wiped or reset install can bootstrap cleanly. */
export function clearClientHubState(options: ClearClientHubStateOptions = {}): void {
  clearRegistrationCache();
  clearStoredDriftChoice();
  setTauriSessionId(null);

  if (!options.keepPortalEmail) {
    clearRememberedPortalAccountEmail();
  }
}
