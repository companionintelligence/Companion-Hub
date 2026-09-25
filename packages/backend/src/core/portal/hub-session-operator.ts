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
 * `cli` and `host-local` are host-local: the CLI JWT is signed with `jwtSecret`
 * and the host-local key is read from the same state file. `portal-device` is
 * Portal itself, presenting the push key this Hub minted for it
 * (`PortalPushKeyService`); it rests on Portal's own GRANT_DENIED gate over the
 * installs it pushes. Every other caller is checked: the exemption used to be
 * inferred from a missing `hubSessionId`, which widened it silently each time an
 * authentication arm was added (CI-Hub#1299).
 */
export function isGrantExemptPrincipal(req: HubPrincipalFields): boolean {
  return req.hubPrincipal === 'portal-device' || req.hubPrincipal === 'cli' || req.hubPrincipal === 'host-local';
}

/**
 * Whether this caller may `view` any app without a grant lookup: a `qa:read` API key.
 *
 * Deliberately NOT folded into {@link isGrantExemptPrincipal}, which every mutating gate and
 * `lifecycleActor` also consult — this admits `view` and nothing else. The key has no person behind
 * it whose grants could be asked, and it is minted only by `cihub` on the host, which already sees
 * every app; it reaches only the GET handlers marked `@ObservabilityRead()`, so the gate is a second
 * wall behind the route list, not the first.
 */
export function isAppViewObserverPrincipal(req: HubPrincipalFields): boolean {
  return req.hubPrincipal === 'qa-read';
}
