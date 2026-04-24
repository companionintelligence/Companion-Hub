import type { ProvisioningPhase, DegradedReason, RegistrationStatus } from '@ci-hub/common/types';

export type { ProvisioningPhase, DegradedReason, RegistrationStatus };

export const REGISTRATION_PROGRESS_PHASES = ['paired', 'provisioning'] as const;

export function isRegistrationOperational(status: RegistrationStatus): boolean {
  return status.registered;
}

export function isRegistrationPending(status: RegistrationStatus): boolean {
  return REGISTRATION_PROGRESS_PHASES.includes(status.phase as (typeof REGISTRATION_PROGRESS_PHASES)[number]);
}

export function requiresDeviceRegistration(status: RegistrationStatus): boolean {
  return status.phase === 'unregistered' || isRegistrationPending(status);
}
