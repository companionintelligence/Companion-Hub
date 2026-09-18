/**
 * Explicit registration and provisioning state model.
 *
 * Replaces the coarse `registered: boolean` with a machine-readable
 * phase + degraded-reason model so the frontend can show the truth
 * about local readiness, public readiness, and recovery.
 */

import {
  PROVISIONING_PHASES,
  type ProvisioningPhase,
  DEGRADED_REASONS,
  type DegradedReason,
  type RegistrationCheckIn,
  type RegistrationPhaseReport,
  type RegistrationStatus,
} from '@ci-hub/common/types';

// Re-export shared types so existing imports from this module continue to work.
export {
  PROVISIONING_PHASES,
  type ProvisioningPhase,
  DEGRADED_REASONS,
  type DegradedReason,
  type RegistrationCheckIn,
  type RegistrationPhaseReport,
  type RegistrationStatus,
};

// ---------------------------------------------------------------------------
// Transition rules
// ---------------------------------------------------------------------------

/**
 * Map of legal forward transitions.
 * `unregistered → *` (reset) is always legal and handled separately.
 */
const LEGAL_TRANSITIONS: Record<ProvisioningPhase, readonly ProvisioningPhase[]> = {
  unregistered: ['paired', 'locally_ready'],
  paired: ['provisioning'],
  provisioning: ['locally_ready', 'degraded'],
  locally_ready: ['publicly_ready', 'degraded'],
  publicly_ready: ['degraded'],
  degraded: ['degraded', 'locally_ready', 'publicly_ready', 'provisioning'],
};

export function isLegalTransition(from: ProvisioningPhase, to: ProvisioningPhase): boolean {
  // Reset (→ unregistered) is always legal from any phase.
  if (to === 'unregistered') return true;
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Returns true when the Hub is operational (usable by the owner).
 * Used by the registration guard and the backward-compat `registered` flag.
 */
export function isOperational(phase: ProvisioningPhase): boolean {
  return phase === 'locally_ready' || phase === 'publicly_ready' || phase === 'degraded';
}

/** The degraded reasons that only pairing again can clear. */
const RE_PAIRING_REASONS: readonly DegradedReason[] = ['tunnel_token_missing', 'portal_rejected'];

/**
 * Whether a registered Hub is expected to pair with Portal again.
 *
 * A Hub that lost its tunnel token is registered but cannot serve publicly, and
 * pairing again is how the token is restored. A Hub whose device key Portal
 * rejects still serves locally, and often through its tunnel too, but no
 * retry revives the key. Neither may be treated as a Hub that is up and
 * serving, or `POST /registration/pair` and the registration callback refuse
 * the one step that fixes them.
 *
 * The frontend's copy of this test (`lib/registration-status.ts`) still checks
 * only `tunnel_token_missing`, because its banner offers a tunnel reconnect
 * that cannot help a rejected key. Until it has its own copy for that reason,
 * a `portal_rejected` Hub pairs with `cihub register --code`.
 */
export function requiresPortalRePairing(phase: ProvisioningPhase, degradedReasons: readonly DegradedReason[]): boolean {
  return phase === 'degraded' && degradedReasons.some((reason) => RE_PAIRING_REASONS.includes(reason));
}

/** Order-insensitive equality, so re-asserting the same degraded state is a no-op. */
export function sameDegradedReasons(a: readonly DegradedReason[], b: readonly DegradedReason[]): boolean {
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort();
  return [...a].sort().every((reason, index) => reason === sortedB[index]);
}

/** Transient phases while a pairing request is being provisioned — not state drift. */
export function isActiveRegistrationPhase(phase: ProvisioningPhase): boolean {
  return phase === 'paired' || phase === 'provisioning';
}

/**
 * Build a {@link RegistrationStatus} snapshot from phase + reasons.
 */
export function buildRegistrationStatus(phase: ProvisioningPhase, degradedReasons: DegradedReason[] = []): RegistrationStatus {
  return {
    phase,
    degradedReasons: phase === 'degraded' ? degradedReasons : [],
    registered: isOperational(phase),
  };
}

/**
 * Parse a stored degradedReasons JSON string into a typed array.
 * Returns an empty array on invalid input.
 */
export function parseDegradedReasons(raw: string | null | undefined): DegradedReason[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r: unknown): r is DegradedReason => DEGRADED_REASONS.includes(r as DegradedReason));
  } catch {
    return [];
  }
}
