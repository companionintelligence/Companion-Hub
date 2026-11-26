import type { ProvisioningPhase, DegradedReason, RegistrationStatus, RegistrationStatusPhase } from '@ci-hub/common/types';

export type { ProvisioningPhase, DegradedReason, RegistrationStatus, RegistrationStatusPhase };

export const REGISTRATION_PROGRESS_PHASES = ['paired', 'provisioning'] as const;

/**
 * The Hub has just started and hasn't read its registration back yet. It says nothing about pairing:
 * wait for the next answer instead of acting on it (#2590).
 */
export function isHubStarting(status: RegistrationStatus): boolean {
  return status.phase === 'starting';
}

export function isRegistrationOperational(status: RegistrationStatus): boolean {
  return status.registered;
}

export function isRegistrationPending(status: RegistrationStatus): boolean {
  return REGISTRATION_PROGRESS_PHASES.includes(status.phase as (typeof REGISTRATION_PROGRESS_PHASES)[number]);
}

export function requiresDeviceRegistration(status: RegistrationStatus): boolean {
  return status.phase === 'unregistered' || isRegistrationPending(status);
}

function isDegradedFor(status: RegistrationStatus, reason: DegradedReason): boolean {
  return status.phase === 'degraded' && status.degradedReasons.includes(reason);
}

/** Portal tunnel was intentionally cleared or is missing — user must re-pair the device. */
export function requiresPortalRePairing(status: RegistrationStatus): boolean {
  return isDegradedFor(status, 'tunnel_token_missing');
}

/**
 * Three check-ins in a row failed. Portal may be down or may have answered: a body it refused counts
 * and so does a refused device key until the refusal has lasted ten minutes. The Hub keeps trying.
 */
export function isPortalCheckInFailing(status: RegistrationStatus): boolean {
  return isDegradedFor(status, 'cloud_validation_failed');
}

/** Portal has gone on refusing this Hub's device key. No retry helps, only pairing again. */
export function isPortalRejected(status: RegistrationStatus): boolean {
  return isDegradedFor(status, 'portal_rejected');
}
