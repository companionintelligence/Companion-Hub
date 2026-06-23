/**
 * Explicit registration and provisioning state model.
 *
 * Replaces the coarse `registered: boolean` with a machine-readable
 * phase + degraded-reason model so the frontend can show the truth
 * about local readiness, public readiness, and recovery.
 */

import { PROVISIONING_PHASES, type ProvisioningPhase, DEGRADED_REASONS, type DegradedReason, type RegistrationStatus } from '@ci-hub/common/types';

// Re-export shared types so existing imports from this module continue to work.
export { PROVISIONING_PHASES, type ProvisioningPhase, DEGRADED_REASONS, type DegradedReason, type RegistrationStatus };

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
