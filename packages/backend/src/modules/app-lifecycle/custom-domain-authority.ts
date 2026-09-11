import { normalizeStoredHostname } from '@ci-hub/common/types';

/** What an installed app holds today, as far as custom domains go. */
export type CustomDomainState = {
  /** The domain the app asks for (`custom_domain_intent`). */
  intent: string | null;
  /** The domain CI-Cloud actually serves it on (`custom_domain`). */
  bound: string | null;
  /** An unspent "yes, move it" answer is already on record. */
  takeover: boolean;
};

/**
 * Whether an install / update-config body would change which custom domain an
 * app serves — the question that needs an organization owner or admin
 * (R2-HUBDOMAINS-1), as opposed to the per-app `install` / `configure` verb.
 *
 * ⚠ ONLY A CHANGE COUNTS. The settings dialog submits the field on every save,
 * seeded from the row, so "the form carries `customDomain`" is true of every
 * edit to an unrelated env var. Gating on presence would lock every member out
 * of their own app's settings the moment it had a domain.
 *
 * A change is: asking for a domain the app neither asks for nor serves; giving
 * one up (`''`) while it asks for or serves one; or confirming a takeover that
 * is not already on record. An app not installed yet (`state === null`) changes
 * something only by asking for a domain.
 */
export function requestsCustomDomainChange(
  form: { customDomain?: unknown; customDomainTakeover?: unknown },
  state: CustomDomainState | null,
): boolean {
  if (typeof form.customDomain !== 'string') {
    return false;
  }

  const wanted = normalizeStoredHostname(form.customDomain);

  if (state === null) {
    return wanted !== null;
  }

  if (wanted === null) {
    return state.intent !== null || state.bound !== null;
  }

  if (form.customDomainTakeover === true && !state.takeover) {
    return true;
  }

  return wanted !== normalizeStoredHostname(state.intent) && wanted !== normalizeStoredHostname(state.bound);
}
