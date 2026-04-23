/**
 * Explicit registration and provisioning state model.
 *
 * Replaces the coarse `registered: boolean` with a machine-readable
 * phase + degraded-reason model so the frontend can show the truth
 * about local readiness, public readiness, and recovery.
 */

// ---------------------------------------------------------------------------
// Provisioning phases
// ---------------------------------------------------------------------------

/**
 * Provisioning phase for a Hub device.
 *
 * Lifecycle:
 *   unregistered → paired → provisioning → locally_ready → publicly_ready
 *                                                      ↘       ↓
 *                                                        degraded
 *
 * `unregistered` is implicit (no DB row); the remaining phases are persisted
 * on the `device_registration` row.
 */
export const PROVISIONING_PHASES = ['unregistered', 'paired', 'provisioning', 'locally_ready', 'publicly_ready', 'degraded'] as const;

export type ProvisioningPhase = (typeof PROVISIONING_PHASES)[number];

// ---------------------------------------------------------------------------
// Degraded reasons
// ---------------------------------------------------------------------------

export const DEGRADED_REASONS = ['tunnel_token_missing', 'tunnel_unreachable', 'cloud_validation_failed'] as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[number];

// ---------------------------------------------------------------------------
// API response shape
// ---------------------------------------------------------------------------

export interface RegistrationStatus {
  /** Current provisioning phase. */
  phase: ProvisioningPhase;
  /** Non-empty only when phase === 'degraded'. */
  degradedReasons: DegradedReason[];
  /** Backward-compat: true when the Hub is operational (locally_ready | publicly_ready | degraded). */
  registered: boolean;
}

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
 * Attempt a phase transition, returning the new phase.
 * @throws {Error} if the transition is illegal.
 */
export function transitionPhase(from: ProvisioningPhase, to: ProvisioningPhase): ProvisioningPhase {
  if (!isLegalTransition(from, to)) {
    throw new Error(`Illegal provisioning-phase transition: ${from} → ${to}`);
  }
  return to;
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
