import type { Request } from 'express';

/**
 * The only parts of a request the grant gate reads. Taking these rather than a whole `Request` lets a
 * caller that decides later — the MCP tool runner names its actor per verb, from inside the tool —
 * keep two fields alive in that async context instead of the entire request.
 */
export type HubPrincipalFields = Pick<Request, 'hubPrincipal' | 'user'>;

/**
 * Hub-session person for org grants, or `undefined` when the caller is not a
 * person whose grants we can look up.
 *
 * Keyed on the named principal, not on `hubSessionId`, so one signal decides:
 * an arm that sets a session id without naming itself reads as unrecognised,
 * which the grant gate refuses.
 */
export function hubSessionOperatorUserId(req: HubPrincipalFields): number | undefined {
  if (req.hubPrincipal !== 'session') {
    return undefined;
  }

  return typeof req.user?.id === 'number' ? req.user.id : undefined;
}

/**
 * Whether this caller is exempt from the org-grant gate, and why.
 *
 * `cli` is host-local: its JWT is signed with `jwtSecret`, which lives in the
 * state file. `portal-device` is not, quite — #1328 injects `HUB_API_KEY` into
 * first-party Memory's container — so it rests on Portal's own GRANT_DENIED gate
 * over the installs it pushes, and on that injection staying first-party only
 * (`AppHelpers.generateEnvFile` strips the key for everything else). Every other
 * caller is checked: the exemption used to be inferred from a missing
 * `hubSessionId`, which widened it silently each time an authentication arm was
 * added (CI-Hub#1299).
 */
export function isGrantExemptPrincipal(req: HubPrincipalFields): boolean {
  return req.hubPrincipal === 'portal-device' || req.hubPrincipal === 'cli';
}
