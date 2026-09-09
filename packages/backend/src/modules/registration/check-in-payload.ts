/**
 * The Companion Hub → Companion Portal check-in wire payload.
 *
 * The check-in exists to ask Portal one question — "is this device still active?" — and it is
 * the only thing this appliance sends Portal on a schedule. Portal's org status report has to
 * answer a second question for a member looking at a fleet: "is my stuff working, and if not,
 * why?" Portal can see when a Hub last checked in, but nothing it stores explains a Hub that
 * checks in happily while its public route is down. Only the Hub knows that. So the facts that
 * answer "why" ride along on the request that is already being made, rather than on a second
 * endpoint with a second schedule and a second failure mode.
 *
 * Two rules govern this shape, and both exist because Hub and Portal deploy independently and
 * field Hubs update late — version skew here is permanent, not transitional.
 *
 * 1. **Every field but `device_id` is optional, and absent means "no report this time, keep
 *    whatever you have".** It never means "the value is gone". A Hub whose Tailscale daemon is
 *    briefly wedged, or whose tunnel probe has not run yet, must not read at Portal as a Hub
 *    that lost its tailnet or lost its tunnel. The same absent-vs-blank contract already governs
 *    `tailscale_dns` on both sides; this extends it rather than inventing a second convention.
 *    It also protects the second caller of this endpoint: registration drift detection posts a
 *    bare `{ device_id }` probe, and that probe must not wipe a device's reported status.
 * 2. **Nothing is sent that the Hub does not genuinely know.** There is no "assume up" default
 *    and no placeholder. In a status report a missing field is honest and a guessed one is a
 *    lie that costs somebody an afternoon.
 *
 * Forward compatibility is free in the other direction: Portal parses the check-in with a strict
 * schema that strips keys it does not recognise, so a Hub that sends these fields to a Portal
 * that predates them gets a normal 200 and the fields are simply dropped.
 */

import type { TunnelHealth } from '../cloudflare/tunnel-health.service';
import type { DegradedReason, ProvisioningPhase } from './registration-state';

/**
 * The check-in request body exactly as it goes on the wire.
 *
 * Keys are snake_case because that is what the existing endpoint speaks (`device_id`,
 * `tailscale_dns`); the Hub's own camelCase stops at this boundary.
 */
export interface CheckInPayload {
  device_id: string;
  tailscale_dns?: string;
  hub_version?: string;
  phase?: ProvisioningPhase;
  degraded_reasons?: DegradedReason[];
  /**
   * Deliberately excludes `'unknown'`. That value is {@link TunnelHealth}'s way of saying "no
   * probe has produced a conclusive result yet" — which is the state a cold Hub is in at exactly
   * the moment it sends its first check-in. Putting it on the wire would hand Portal a fourth
   * state to render and invite it to draw a warning for a tunnel nobody has measured yet.
   */
  tunnel_health?: Exclude<TunnelHealth, 'unknown'>;
  tailscale_connected?: boolean;
}

/**
 * What the Hub knows, in the Hub's own vocabulary, before any of it is translated to the wire.
 *
 * Every optional member accepts `null` and `undefined` alike so callers can pass a best-effort
 * read straight through without pre-normalising it: a service that is not wired up, a cache that
 * has no answer, and a probe that failed all mean the same thing here — omit the field.
 */
export interface CheckInFacts {
  deviceId: string;
  /**
   * This node's Tailscale MagicDNS name. Predates the status report: it feeds the Portal leg of
   * Hub Pool discovery, which reads it back out of Portal in `hub-pool-discovery.service.ts`.
   */
  nodeFqdn?: string | null;
  /** Whether the Tailscale daemon reports itself connected to the tailnet right now. */
  tailscaleConnected?: boolean | null;
  /** `CI_HUB_VERSION` for this appliance, so a fleet view can spot a Hub that never updated. */
  hubVersion?: string | null;
  /** The in-memory provisioning phase. Always known, so always reported. */
  phase: ProvisioningPhase;
  /** Reasons behind a `degraded` phase; meaningless in any other phase. */
  degradedReasons?: readonly DegradedReason[];
  /** Cached liveness of the public origin, or `'unknown'`/nullish when nothing conclusive. */
  tunnelHealth?: TunnelHealth | null;
}

/**
 * Translates what the Hub knows into the check-in body, dropping everything it does not.
 *
 * Kept as a pure function rather than an object literal inside the service so the omission rules
 * above — the part that is easy to get wrong and expensive to get wrong — can be asserted field
 * by field without standing up a Portal or mocking HTTP.
 */
export function buildCheckInPayload(facts: CheckInFacts): CheckInPayload {
  const payload: CheckInPayload = { device_id: facts.deviceId };

  if (facts.nodeFqdn) {
    payload.tailscale_dns = facts.nodeFqdn;
  }

  // `hubVersion` is read from configuration, which leaves it undefined in environments that never
  // set `CI_HUB_VERSION` (dev shells, tests). An empty string is not a version, so it is omitted
  // rather than reported as one.
  if (facts.hubVersion) {
    payload.hub_version = facts.hubVersion;
  }

  // The phase is held in memory and is the single most useful field here: it is what turns
  // "last seen four minutes ago" into "the tunnel token is missing, re-pair this Hub". There is
  // no failure mode that leaves it unknown, so it is unconditional.
  payload.phase = facts.phase;

  // Mirror `buildRegistrationStatus`: reasons only mean something alongside a `degraded` phase,
  // and stale reasons attached to a healthy Hub would read as a fault that has already cleared.
  // An empty array is omitted too — it asserts nothing that `phase` has not already said.
  if (facts.phase === 'degraded' && facts.degradedReasons && facts.degradedReasons.length > 0) {
    payload.degraded_reasons = [...facts.degradedReasons];
  }

  // See `CheckInPayload.tunnel_health`: `'unknown'` is the absence of an opinion, and the wire
  // already has a way to express that.
  if (facts.tunnelHealth && facts.tunnelHealth !== 'unknown') {
    payload.tunnel_health = facts.tunnelHealth;
  }

  // Only a real boolean is reported. `undefined` here means the Tailscale service is absent or
  // gave no answer, which is not the same claim as "this node is disconnected from its tailnet"
  // — and on a Hub that does not use Tailscale at all, a hard `false` would look like a fault.
  if (typeof facts.tailscaleConnected === 'boolean') {
    payload.tailscale_connected = facts.tailscaleConnected;
  }

  return payload;
}
