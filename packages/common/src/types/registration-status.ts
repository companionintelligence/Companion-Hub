export const PROVISIONING_PHASES = ['unregistered', 'paired', 'provisioning', 'locally_ready', 'publicly_ready', 'degraded'] as const;

export type ProvisioningPhase = (typeof PROVISIONING_PHASES)[number];

export const DEGRADED_REASONS = ['tunnel_token_missing', 'tunnel_unreachable', 'cloud_validation_failed'] as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export interface RegistrationStatus {
  phase: ProvisioningPhase;
  degradedReasons: DegradedReason[];
  /** Backward-compat: true when the Hub is operational (locally_ready | publicly_ready | degraded). */
  registered: boolean;
}
