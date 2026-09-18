import { HubUnreachableError, resolveHubApiBase } from '../public-web-cli.js';

export type RegistrationPhase = 'unregistered' | 'paired' | 'provisioning' | 'locally_ready' | 'publicly_ready' | 'degraded';

export type RegistrationStatusResponse = {
  phase: RegistrationPhase;
  registered: boolean;
  degradedReasons?: string[];
};

/** `GET /api/registration/phase`: the status plus the last check-in, read without sending one. */
export type RegistrationPhaseResponse = RegistrationStatusResponse & {
  lastCheckIn: { at: string; httpStatus: number | null; code: string | null; error: string | null } | null;
  consecutiveCheckInFailures?: number;
};

/** The Hub answered 404: its build predates `GET /api/registration/phase`. */
export class RegistrationPhaseRouteMissing extends Error {
  constructor() {
    super('this Hub build has no /api/registration/phase');
    this.name = 'RegistrationPhaseRouteMissing';
  }
}

/**
 * Reads the phase without triggering a check-in.
 *
 * Not `fetchRegistrationStatus`: `GET /registration/status` sends a check-in to Portal once its
 * 30 s throttle has passed, so a diagnostic that read it would change the `last_seen` it was trying
 * to observe.
 */
export async function fetchRegistrationPhase(apiBase: string): Promise<RegistrationPhaseResponse> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/registration/phase`, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new HubUnreachableError(`Cannot reach the Hub at ${apiBase} — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (res.status === 404) {
    throw new RegistrationPhaseRouteMissing();
  }
  if (!res.ok) {
    throw new Error(`Registration phase failed (${res.status})`);
  }
  return (await res.json()) as RegistrationPhaseResponse;
}

export type DeviceIdResponse = {
  device_id?: string;
  ci_cloud_url?: string | null;
  registration_url?: string | null;
  /** Absent on a Hub predating the check. `foreign` means the Hub will refuse to pair; `message` says what to do. */
  device_id_host?: { status: string; message: string | null };
};

export type PairResponse = {
  success?: boolean;
  message?: string;
  /** The Portal's refusal code, such as `DEVICE_MOVE_CONFIRMATION_REQUIRED`. */
  code?: string;
  /** With `DEVICE_MOVE_CONFIRMATION_REQUIRED`, the organization pairing would move this Hub into. */
  organizationName?: string;
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

/**
 * Builds the Hub access URL from the pair response. `subdomain` is normally a bare
 * label (e.g. "hub-core7-team") that must be joined with the root `domain`
 * (e.g. "companionintelligence.com"), but full hostnames and URLs are passed through.
 */
export function formatHubAccessUrl(domain?: string, subdomain?: string): string | undefined {
  const hasScheme = (value: string) => value.startsWith('http://') || value.startsWith('https://');
  const root = domain?.trim();
  const sub = subdomain?.trim();
  if (sub && hasScheme(sub)) return sub;
  if (!sub) {
    if (!root) return undefined;
    return hasScheme(root) ? root : `https://${root}`;
  }
  if (!root) return `https://${sub}`;
  const host = sub === root || sub.endsWith(`.${root}`) ? sub : `${sub}.${root}`;
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

/**
 * `deviceKey` is the host-local device key from `state/settings.json`, when this machine has one.
 * A first pairing needs no credential, but the Hub re-pairs an already registered Hub (a key Portal
 * rejects, a lost tunnel token) only for an authenticated caller, and this is how `cihub register`
 * on the Hub itself is one.
 */
export async function submitPairingCode(
  apiBase: string,
  pairingCode: string,
  deviceKey?: string,
  { confirmMove = false }: { confirmMove?: boolean } = {},
): Promise<PairResponse> {
  const res = await fetch(`${apiBase}/api/registration/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(deviceKey ? { Authorization: `Bearer ${deviceKey}` } : {}) },
    body: JSON.stringify({ pairing_code: normalizePairingCode(pairingCode), ...(confirmMove ? { confirm_move: true } : {}) }),
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
