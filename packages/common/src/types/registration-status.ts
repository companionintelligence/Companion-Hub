export const PROVISIONING_PHASES = ['unregistered', 'paired', 'provisioning', 'locally_ready', 'publicly_ready', 'degraded'] as const;

export type ProvisioningPhase = (typeof PROVISIONING_PHASES)[number];

/**
 * Why a registered Hub is `degraded`.
 *
 * `cloud_validation_failed` is the transient one: Portal could not be asked, or answered with
 * something that is not a verdict (5xx, a proxy page, a refused request body), three times running.
 *
 * `portal_rejected` is the definitive one: Portal answered, and it does not accept this Hub's device
 * key. On the 2026-09-17 fleet it was the true state of five Hubs that had sat under
 * `cloud_validation_failed` for up to a week, retrying a key that no retry could revive. Pairing
 * again is the only way out, so it is one of the reasons that reopens pairing.
 */
export const DEGRADED_REASONS = ['tunnel_token_missing', 'tunnel_unreachable', 'cloud_validation_failed', 'portal_rejected'] as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export interface RegistrationStatus {
  phase: ProvisioningPhase;
  degradedReasons: DegradedReason[];
  /** Backward-compat: true when the Hub is operational (locally_ready | publicly_ready | degraded). */
  registered: boolean;
}

/** The outcome of the last check-in this Hub process sent to Portal. */
export interface RegistrationCheckIn {
  /** ISO timestamp of when the answer (or the failure) came back. */
  at: string;
  /** Portal's HTTP status, or null when no response arrived (DNS, TCP, TLS, or timeout). */
  httpStatus: number | null;
  /** Portal's machine-readable refusal code (`UNAUTHORIZED`, `DEVICE_NOT_ACTIVE`), when the body carried one. */
  code: string | null;
  /** A short, scrubbed description of a failure; null when Portal accepted the check-in. */
  error: string | null;
}

/**
 * `GET /api/registration/phase`: the registration status plus the last check-in, read without
 * sending one.
 */
export interface RegistrationPhaseReport extends RegistrationStatus {
  /** Null until this process has checked in once. It is in memory, so a restart clears it. */
  lastCheckIn: RegistrationCheckIn | null;
  /** Transient failures in a row. Three of them set `cloud_validation_failed`. */
  consecutiveCheckInFailures: number;
}
