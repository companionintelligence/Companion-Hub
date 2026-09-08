import type { Request } from 'express';

/**
 * Hub-session person for org grants, or `undefined` when the caller is not a
 * person whose grants we can look up.
 */
export function hubSessionOperatorUserId(req: Request): number | undefined {
  if (!req.hubSessionId) {
    return undefined;
  }

  return typeof req.user?.id === 'number' ? req.user.id : undefined;
}

/**
 * Whether this caller is exempt from the org-grant gate, and WHY.
 *
 * ⚠ AN EXEMPTION HAS TO BE A DECISION, NOT AN ABSENCE. Every grant entry point
 * used to read "no `hubSessionId`" as "no person to check, allow". That is true
 * of a Portal push — whose authorization is Portal's own GRANT_DENIED gate,
 * which is a real answer — but it was equally true of the CLI JWT arm, and of
 * any authentication arm added later that did not happen to set a session. The
 * exemption therefore widened every time the middleware grew, silently, and the
 * comment that justified it named only one of the arms it covered.
 *
 * Both exempt principals are HOST-LOCAL by construction: the device key and the
 * JWT signing secret live in the same state file, so presenting either means the
 * caller could already read it. That is the property the exemption rests on, and
 * it is why `HUB_API_KEY` must never be issued to an app container — see the
 * delete in `AppHelpers.generateEnvFile`, which is what stopped every installed
 * app holding one.
 *
 * Anything else is NOT exempt. A request that reaches a gated route with no
 * recognised principal is a bug in the middleware, and the safe reading of a bug
 * here is a refusal.
 */
export function isGrantExemptPrincipal(req: Request): boolean {
  return req.hubPrincipal === 'portal-device' || req.hubPrincipal === 'cli';
}
