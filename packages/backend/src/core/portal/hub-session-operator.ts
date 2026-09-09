import type { Request } from 'express';

/**
 * Hub-session person for org grants, or `undefined` when the caller is not a
 * person whose grants we can look up.
 *
 * Keyed on the named principal, not on `hubSessionId`, so one signal decides:
 * an arm that sets a session id without naming itself reads as unrecognised,
 * which the grant gate refuses.
 */
export function hubSessionOperatorUserId(req: Request): number | undefined {
  if (req.hubPrincipal !== 'session') {
    return undefined;
  }

  return typeof req.user?.id === 'number' ? req.user.id : undefined;
}

/**
 * Whether this caller is exempt from the org-grant gate, and why.
 *
 * Both exempt principals are host-local by construction: the device key and the
 * JWT signing secret live in the same state file, so presenting either means the
 * caller could already read it, and Portal runs its own GRANT_DENIED gate over
 * the installs it pushes. Every other caller is checked — the exemption used to
 * be inferred from a missing `hubSessionId`, which widened it silently each time
 * an authentication arm was added (CI-Hub#1299).
 */
export function isGrantExemptPrincipal(req: Request): boolean {
  return req.hubPrincipal === 'portal-device' || req.hubPrincipal === 'cli';
}
