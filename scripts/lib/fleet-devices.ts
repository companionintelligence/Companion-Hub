/**
 * The rest of a device's life in Portal, from the CLI: list an organization's devices, mint a
 * replacement pairing code for one, delete one.
 *
 * `cihub fleet install` could mint devices with its token and do nothing else with it. Reinstalling
 * fifteen nodes from scratch on 2026-09-18 left four that Portal still knew — three under their old
 * organization (`403 DEVICE_PROOF_REQUIRED` on every pairing attempt: the wipe had destroyed the key
 * that would prove ownership) and one whose name an earlier failed attempt had taken. Every one of
 * them needed a person in the browser, and this file is so they do not. A `device:manage` login is
 * required; the `device:pair` one a fleet install holds is refused by Portal on these routes.
 */
import { DEVICE_MANAGE_SCOPE, loginScope, type PortalLogin } from './catalog-submit.js';

export interface PortalDevice {
  /** The device's own id — `inactive-<uuid>` until it pairs, the appliance's device_id after. What `/api/devices/:deviceId` keys on. */
  id: string;
  /** Portal's registration row for the device in this organization. Shown, never used to address the device. */
  registrationId?: string;
  name: string;
  slug?: string;
  status?: string;
  organizationId?: string;
  lastSeenAt?: string | null;
  createdAt?: string | null;
}

export function requireManageLogin(login: PortalLogin | null | undefined): PortalLogin {
  if (!login) throw new Error(`no Portal login stored; run: cihub login --scope ${DEVICE_MANAGE_SCOPE}`);
  if (loginScope(login) !== DEVICE_MANAGE_SCOPE) {
    throw new Error(`the stored Portal login has scope ${loginScope(login)}; managing devices needs: cihub login --scope ${DEVICE_MANAGE_SCOPE}`);
  }
  return login;
}

function headers(login: PortalLogin): Record<string, string> {
  return { Authorization: `Bearer ${login.token}`, Accept: 'application/json' };
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  const detail = body.error ?? `HTTP ${response.status}`;
  if (response.status === 401) return `${detail} — Portal refused this token; a device:manage login is required, and this Portal must accept it`;
  if (response.status === 403) return `${detail} — only an owner or admin of the organization may do this`;
  if (response.status === 404) return `${detail} — no such device, or not in an organization this login belongs to`;
  return detail;
}

/** Normalise Portal's device row; field names differ between its endpoints. */
function toDevice(raw: Record<string, unknown>): PortalDevice {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && value) return value;
    }
    return undefined;
  };
  return {
    // ListDevices answers `id` = the registration row and `deviceId` = the device; the
    // `/api/devices/:deviceId` routes take the device. The first version of this picked `id` and
    // every release and re-register answered 404.
    id: pick('deviceId', 'device_id') ?? pick('id') ?? '',
    registrationId: pick('id'),
    name: pick('name', 'displayName') ?? '',
    slug: pick('slug'),
    status: pick('status'),
    organizationId: pick('organizationId', 'organization_id'),
    lastSeenAt: pick('lastSeenAt', 'last_seen_at') ?? null,
    createdAt: pick('createdAt', 'created_at') ?? null,
  };
}

export async function listPortalDevices(params: { login: PortalLogin; organizationId?: string; fetchImpl?: typeof fetch }): Promise<PortalDevice[]> {
  const login = requireManageLogin(params.login);
  const fetchImpl = params.fetchImpl ?? fetch;
  const url = new URL('/api/devices', login.portalOrigin);
  url.searchParams.set('organizationId', params.organizationId ?? login.orgId);
  const response = await fetchImpl(url, { headers: headers(login) });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as { devices?: Record<string, unknown>[] } | Record<string, unknown>[];
  const rows = Array.isArray(body) ? body : (body.devices ?? []);
  return rows.map(toDevice);
}

/**
 * Find one device by name, slug or Portal id. Exact match only — a fleet has `core-1` and `core-17`,
 * and this precedes a delete.
 */
export function findPortalDevice(devices: readonly PortalDevice[], target: string): { device?: PortalDevice; why?: string } {
  const needle = target.trim().toLowerCase();
  const matches = devices.filter((d) => [d.id, d.registrationId, d.name, d.slug].some((v) => v && v.toLowerCase() === needle));
  if (matches.length === 1) return { device: matches[0] };
  if (matches.length === 0) return { why: `no device named or identified '${target}' in this organization (${devices.length} listed)` };
  return { why: `'${target}' matches ${matches.length} devices: ${matches.map((d) => `${d.name} (${d.id})`).join(', ')} — use the id` };
}

export async function deletePortalDevice(params: {
  login: PortalLogin;
  deviceId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ warnings?: string[] }> {
  const login = requireManageLogin(params.login);
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL(`/api/devices/${encodeURIComponent(params.deviceId)}`, login.portalOrigin), {
    method: 'DELETE',
    headers: headers(login),
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json().catch(() => ({}))) as { warnings?: string[] };
  return { warnings: body.warnings };
}

/** Mint a replacement pairing code: the device stays in the org, marked inactive until it pairs again. */
export async function reRegisterPortalDevice(params: {
  login: PortalLogin;
  deviceId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ pairingCode: string; deviceId: string }> {
  const login = requireManageLogin(params.login);
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL(`/api/devices/${encodeURIComponent(params.deviceId)}/re-register`, login.portalOrigin), {
    method: 'POST',
    headers: headers(login),
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as { pairingCode?: string; deviceId?: string };
  if (!body.pairingCode) throw new Error('Portal re-registered the device but returned no pairing code');
  return { pairingCode: body.pairingCode, deviceId: body.deviceId ?? params.deviceId };
}
