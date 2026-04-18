export const REGISTRATION_PROGRESS_PHASES = ['paired', 'provisioning'] as const;

export type ProvisioningPhase = 'unregistered' | 'paired' | 'provisioning' | 'locally_ready' | 'publicly_ready' | 'degraded';

export type DegradedReason = 'tunnel_token_missing' | 'tunnel_unreachable' | 'cloud_validation_failed';

export interface RegistrationStatus {
  phase: ProvisioningPhase;
  degradedReasons: DegradedReason[];
  /** Backward-compat: true when phase is locally_ready, publicly_ready, or degraded. */
  registered: boolean;
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
