export type StateDriftReason =
  | 'local_unregistered_portal_active'
  | 'stale_hub_device_id_in_app_data'
  | 'stale_tunnel_token'
  | 'orphaned_local_db_registration';

export interface StateDriftSignal {
  reason: StateDriftReason;
  detail?: string;
}

export interface RegistrationStateDrift {
  detected: boolean;
  hardwareDeviceId: string;
  localRegistered: boolean;
  portalDeviceActive: boolean | null;
  staleAppEnvDeviceIds: string[];
  signals: StateDriftSignal[];
  hasStaleTunnelToken: boolean;
}

export type RegistrationDriftChoice = 'fresh' | 'restore';

const DRIFT_CHOICE_KEY = 'ci-hub-registration-drift-choice';

export function getStoredDriftChoice(): RegistrationDriftChoice | null {
  const value = sessionStorage.getItem(DRIFT_CHOICE_KEY);
  if (value === 'fresh' || value === 'restore') {
    return value;
  }
  return null;
}

export function storeDriftChoice(choice: RegistrationDriftChoice) {
  sessionStorage.setItem(DRIFT_CHOICE_KEY, choice);
}

export function clearStoredDriftChoice() {
  sessionStorage.removeItem(DRIFT_CHOICE_KEY);
}
