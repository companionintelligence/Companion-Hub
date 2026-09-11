import { normalizeStoredHostname } from '@ci-hub/common/types';

/** What an installed app holds today, as far as custom domains go. */
export type CustomDomainState = {
  /** The domain the app asks for (`custom_domain_intent`). */
  intent: string | null;
  /** The domain CI-Cloud actually serves it on (`custom_domain`). */
  bound: string | null;
  /** An unspent "yes, move it" answer is already on record. */
  takeover: boolean;
  /**
   * Another app on this Hub asks for the domain this save submits. Re-recording
   * it here would take that app's choice away (`claimCustomDomainIntent`),
   * cancelling a move somebody else started. Read only for a save that would
   * otherwise change nothing; see {@link requestsCustomDomainChange}.
   */
  wantedElsewhere: boolean;
};

/** The fields of an install / update-config form that say anything about custom domains. */
export type CustomDomainForm = {
  customDomain?: unknown;
  customDomainTakeover?: unknown;
  customDomainExpected?: unknown;
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
 * ⚠ AND "NOT A CHANGE" HAS TO MEAN THE SAVE MOVES NOTHING, because it is let
 * through without a role. So this follows what a save writes rather than what
 * the picker shows: the service compares the domain with the recorded CHOICE,
 * writes the takeover answer from the form, and `claimCustomDomainIntent` takes
 * the domain from any other app asking for it. A change is:
 * - asking for a domain other than the app's choice — or, with no choice
 *   recorded, other than the one it is bound to;
 * - giving one up (`''`) while it asks for or serves one;
 * - a takeover answer other than the one on record: confirming a move nobody
 *   approved, or withdrawing one somebody did;
 * - re-submitting its own choice or its binding while another app asks for
 *   that domain, which would cancel the move somebody else started.
 *
 * An app not installed yet (`state === null`) changes something only by asking
 * for a domain.
 */
export function requestsCustomDomainChange(form: CustomDomainForm, state: CustomDomainState | null): boolean {
  if (typeof form.customDomain !== 'string') {
    return false;
  }

  const wanted = normalizeStoredHostname(form.customDomain);

  if (state === null) {
    return wanted !== null;
  }

  /*
   * Normalized once, here, so a blank column reads as the null it means: a row
   * holding `''` would otherwise make every "platform address" save a release.
   */
  const intent = normalizeStoredHostname(state.intent);
  const bound = normalizeStoredHostname(state.bound);

  if (wanted === null) {
    return intent !== null || bound !== null;
  }

  const takeover = form.customDomainTakeover === true;

  /*
   * Bound by CI-Cloud with no choice recorded: the dialog seeds the picker with
   * `intent ?? bound`, so every save re-submits the binding. That echo moves
   * nothing — unless another app is waiting for the domain, or it carries a
   * takeover answer the row does not have.
   */
  if (intent === null && wanted === bound) {
    return takeover || state.wantedElsewhere;
  }

  return wanted !== intent || takeover !== state.takeover || state.wantedElsewhere;
}
