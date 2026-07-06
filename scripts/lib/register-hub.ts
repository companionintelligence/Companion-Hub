import { resolveHubApiBase } from '../public-web-cli.js';

export type RegistrationPhase = 'unregistered' | 'paired' | 'provisioning' | 'locally_ready' | 'publicly_ready' | 'degraded';

export type RegistrationStatusResponse = {
  phase: RegistrationPhase;
  registered: boolean;
  degradedReasons?: string[];
};

export type DeviceIdResponse = {
  device_id?: string;
  ci_cloud_url?: string | null;
  registration_url?: string | null;
};

export type PairResponse = {
  success?: boolean;
  message?: string;
  domain?: string;
  subdomain?: string;
};

export type StateDriftReason =
  | 'local_unregistered_portal_active'
  | 'stale_hub_device_id_in_app_data'
  | 'stale_tunnel_token'
  | 'orphaned_local_db_registration';

export type RegistrationStateDrift = {
  detected: boolean;
  hardwareDeviceId: string;
  localRegistered: boolean;
  portalDeviceActive: boolean | null;
  staleAppEnvDeviceIds: string[];
  signals: { reason: StateDriftReason; detail?: string }[];
  hasStaleTunnelToken: boolean;
};

export type PrepareFreshResponse = {
  success: boolean;
  message: string;
  clearedAppEnvFiles?: number;
};

export function normalizePairingCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function isValidPairingCode(code: string): boolean {
  return normalizePairingCode(code).length === 6;
}

export function registrationComplete(status: RegistrationStatusResponse): boolean {
  return status.registered && (status.phase === 'publicly_ready' || status.phase === 'locally_ready');
}

export function formatHubAccessUrl(domain?: string, subdomain?: string): string | undefined {
  const host = (subdomain || domain)?.trim();
  if (!host) return undefined;
  if (host.startsWith('http://') || host.startsWith('https://')) return host;
  return `https://${host}`;
}

export async function waitForHubApi(apiBase: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiBase}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      // Hub still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

export async function fetchRegistrationStatus(apiBase: string): Promise<RegistrationStatusResponse> {
  const res = await fetch(`${apiBase}/api/registration/status`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Registration status failed (${res.status})`);
  }
  return (await res.json()) as RegistrationStatusResponse;
}

export async function fetchDeviceId(apiBase: string): Promise<DeviceIdResponse> {
  const res = await fetch(`${apiBase}/api/registration/device-id`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Device ID lookup failed (${res.status})`);
  }
  return (await res.json()) as DeviceIdResponse;
}

export async function fetchStateDrift(apiBase: string): Promise<RegistrationStateDrift> {
  const res = await fetch(`${apiBase}/api/registration/state-drift`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`State drift check failed (${res.status})`);
  }
  return (await res.json()) as RegistrationStateDrift;
}

export async function prepareFreshSetup(apiBase: string): Promise<PrepareFreshResponse> {
  const res = await fetch(`${apiBase}/api/registration/prepare-fresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json()) as PrepareFreshResponse;
  if (!res.ok && !data.message) {
    return { success: false, message: `Prepare fresh failed (${res.status})` };
  }
  return data;
}

export async function submitPairingCode(apiBase: string, pairingCode: string): Promise<PairResponse> {
  const res = await fetch(`${apiBase}/api/registration/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: normalizePairingCode(pairingCode) }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json()) as PairResponse;
  if (!res.ok && !data.message) {
    return { success: false, message: `Pairing request failed (${res.status})` };
  }
  return data;
}

export async function pollRegistrationComplete(
  apiBase: string,
  timeoutMs: number,
  onTick?: (status: RegistrationStatusResponse) => void,
): Promise<RegistrationStatusResponse | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetchRegistrationStatus(apiBase);
    onTick?.(status);
    if (registrationComplete(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}

export function resolveRegisterApiBase(envFileName: string): string {
  return resolveHubApiBase(envFileName);
}
