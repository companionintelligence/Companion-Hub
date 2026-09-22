/**
 * Pairing codes a fleet install has minted but not yet spent.
 *
 * A Portal pairing code is one device's credential: minting it creates the device record, and Portal
 * refuses a second device by the same name. So a run that mints a code and then fails somewhere
 * before `register` has left the name taken and the code nowhere — the next attempt gets
 * `409 a device named "core-7" already exists` and cannot proceed without a human deleting the
 * orphan in the Portal UI (the `device:pair` token cannot list or delete devices). That is how the
 * first fleet install went, on 2026-09-18, on its very first node.
 *
 * The fix is to remember. A minted code is written here, keyed by the node's address, until the
 * node has verifiably registered; a retry reuses it. Kept beside the Portal login it belongs to,
 * owner-readable only, and scoped to the org the login was for — a code minted for one org means
 * nothing to another.
 *
 * A kept code can also die before it is spent: `cihub fleet devices re-register` mints a
 * replacement through Portal, and Portal honours only the newest. On 2026-09-20 a re-register of
 * core-1 was followed by a `fleet install` that reused the code it had kept from the day before and
 * failed at register with "Pairing failed". So a re-register is recorded here too — the kept code
 * for the device is replaced with the new one, and every re-register is logged so an install that
 * still finds an older code says why it cannot use it instead of trying.
 *
 * A third way a kept code dies: Portal itself says so. On 2026-09-22, three independently-minted
 * codes for beta-max were all rejected `410 PAIRING_CODE_INVALID` — one within seconds of being
 * minted — with no `fleet devices re-register` involved at all, so `findInvalidatingReRegistration`
 * never fires and this file has no record that anything is wrong. Without a fix, every retry reuses
 * the same dead code and fails identically forever: `reusing the code minted 2026-09-22T06:34 for
 * beta-1` survived a device release and two more `fleet install` attempts unchanged. `register`'s own
 * failure is the only signal available, so a step whose output names this specific Portal error
 * clears the kept code — see `isDeadPairingCodeFailure` — while every other failure (a slow DNS/tunnel
 * provisioning step timing out per #1580, a transient network blip) still keeps it, exactly as
 * before: those may yet succeed with the same code, and re-minting on every failure is what caused
 * the 2026-09-18 orphan-device incident this file exists to prevent.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loginFilePath } from './catalog-submit.js';

export interface PendingPairingCode {
  ip: string;
  name: string;
  slug: string;
  deviceId: string;
  pairingCode: string;
  orgId: string;
  mintedAt: string;
  /** Set when `fleet devices re-register` minted this code rather than `fleet install`. */
  reRegisteredAt?: string;
}

/** A `fleet devices re-register` this machine ran. Every code for the device minted before `at` is dead. */
export interface ReRegisteredDevice {
  deviceId: string;
  name: string;
  slug?: string;
  orgId: string;
  at: string;
}

interface Store {
  /** By the roster node's address — what `fleet install` looks a node up by. */
  codes: Record<string, PendingPairingCode>;
  /** By org and device, latest only. */
  reRegistered: Record<string, ReRegisteredDevice>;
}

export function pendingPairingCodesPath(loginPath = loginFilePath()): string {
  return path.join(path.dirname(loginPath), 'fleet-pending-pairing-codes.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readStore(file: string): Store {
  const empty: Store = { codes: {}, reRegistered: {} };
  if (!existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!isRecord(parsed)) return empty;
    // The first version of this file was the codes map alone. A file it wrote has entries at the
    // top level, each with a pairing code; one written since has them under `codes`.
    if (isRecord(parsed.codes) && typeof parsed.codes.pairingCode !== 'string') {
      return {
        codes: parsed.codes as Store['codes'],
        reRegistered: isRecord(parsed.reRegistered) ? (parsed.reRegistered as Store['reRegistered']) : {},
      };
    }
    return { codes: parsed as Store['codes'], reRegistered: {} };
  } catch {
    return empty;
  }
}

function writeStore(file: string, store: Store): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The code kept for this node, if one was minted for this org and never spent. */
export function readPendingPairingCode(ip: string, orgId: string, file = pendingPairingCodesPath()): PendingPairingCode | undefined {
  const entry = readStore(file).codes[ip];
  return entry && entry.orgId === orgId ? entry : undefined;
}

export function savePendingPairingCode(entry: PendingPairingCode, file = pendingPairingCodesPath()): void {
  const store = readStore(file);
  store.codes[entry.ip] = entry;
  writeStore(file, store);
}

/** Forget a code once `register` has verifiably spent it. */
export function clearPendingPairingCode(ip: string, file = pendingPairingCodesPath()): void {
  const store = readStore(file);
  if (!(ip in store.codes)) return;
  delete store.codes[ip];
  writeStore(file, store);
}

const lower = (value: string | undefined): string => (value ?? '').trim().toLowerCase();

/**
 * Whether a Portal device and a kept code (or a re-register record) are the same device, by any of
 * the names the two sides hold. `fleet install` mints under the roster node's name, Portal answers
 * with a slug derived from it, and a device's id changes when it pairs — so a name or slug match is
 * the reliable one and the id is a bonus.
 */
function sameDevice(a: { deviceId?: string; name?: string; slug?: string }, b: { deviceId?: string; name?: string; slug?: string }): boolean {
  if (a.deviceId && b.deviceId && a.deviceId === b.deviceId) return true;
  const aNames = [lower(a.name), lower(a.slug)].filter(Boolean);
  const bNames = [lower(b.name), lower(b.slug)].filter(Boolean);
  return aNames.some((n) => bNames.includes(n));
}

function parseTime(iso: string | undefined): number {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

export interface ReRegisterRecordResult {
  /** The roster address the new code was kept under, when a roster node could be matched. */
  ip?: string;
  /** The roster node's name — what `fleet install --nodes` takes. */
  node?: string;
  /** The code this one replaced, if `fleet install` had kept one for the device. */
  replaced?: PendingPairingCode;
  /** Why nothing was kept, when nothing was. */
  why?: string;
}

/**
 * Record a `fleet devices re-register`: the old code for this device is dead, the new one is what
 * the next `fleet install` must send.
 *
 * The new code is kept under the roster node whose name is the device's name or slug — the same
 * mapping `fleet install` uses when it mints, `node.name` → Portal device name — and every code this
 * file was keeping for the device, at any address, is dropped. Without a matching roster node the
 * code is kept where an earlier install had kept one; with neither there is nowhere `fleet install`
 * would look, and the caller tells the operator to pass `--code`. The re-register is logged either
 * way, so an older code that somehow survives is refused by name rather than sent.
 */
export function recordReRegisteredPairingCode(
  params: {
    device: { id: string; name: string; slug?: string };
    /** The device id Portal answered the re-register with; the same as `device.id` unless it changed. */
    deviceId: string;
    pairingCode: string;
    orgId: string;
    roster: readonly { name: string; ip: string }[];
    at?: string;
  },
  file = pendingPairingCodesPath(),
): ReRegisterRecordResult {
  const at = params.at ?? new Date().toISOString();
  const store = readStore(file);
  const identity = { deviceId: params.device.id, name: params.device.name, slug: params.device.slug };

  store.reRegistered[`${params.orgId}:${lower(params.device.slug) || lower(params.device.name) || params.device.id}`] = {
    deviceId: params.deviceId,
    name: params.device.name,
    slug: params.device.slug,
    orgId: params.orgId,
    at,
  };

  const stale = Object.values(store.codes).filter((entry) => entry.orgId === params.orgId && sameDevice(entry, identity));
  for (const entry of stale) delete store.codes[entry.ip];

  const matched = params.roster.filter((node) => [lower(params.device.name), lower(params.device.slug)].filter(Boolean).includes(lower(node.name)));
  // Roster names are labels, not identities; two rows may share one. Then the address an earlier
  // install minted for is the one to trust, and with no such address there is no safe guess.
  const chosen =
    matched.length === 1 ? matched[0] : matched.length > 1 ? matched.find((node) => stale.some((entry) => entry.ip === node.ip)) : undefined;
  const keepUnder = chosen ?? (stale.length === 1 ? stale[0] : undefined);

  if (!keepUnder) {
    writeStore(file, store);
    const aliases =
      params.device.slug && lower(params.device.slug) !== lower(params.device.name)
        ? `${params.device.name} or ${params.device.slug}`
        : params.device.name;
    const why =
      matched.length > 1
        ? `${matched.length} roster nodes are named ${params.device.name} (${matched.map((n) => n.ip).join(', ')}), so the code was kept for none of them`
        : `no roster node is named ${aliases}, so the code was kept for none`;
    return { replaced: stale[0], why };
  }

  const { ip, name: node } = keepUnder;
  store.codes[ip] = {
    ip,
    name: node,
    slug: params.device.slug ?? params.device.name,
    deviceId: params.deviceId,
    pairingCode: params.pairingCode,
    orgId: params.orgId,
    mintedAt: at,
    reRegisteredAt: at,
  };
  writeStore(file, store);
  return { ip, node, replaced: stale.find((entry) => entry.ip === ip) ?? stale[0] };
}

/**
 * The re-register, if any, that has made this kept code useless: same org, same device, minted
 * after the code was. A code re-register itself kept is never its own invalidation.
 */
export function findInvalidatingReRegistration(pending: PendingPairingCode, file = pendingPairingCodesPath()): ReRegisteredDevice | undefined {
  const latest = findReRegistration(pending, pending.orgId, file);
  return latest && parseTime(latest.at) > parseTime(pending.mintedAt) ? latest : undefined;
}

/** The latest re-register this machine recorded for a device in this org, whether or not a code is kept. */
export function findReRegistration(
  device: string | { deviceId?: string; name?: string; slug?: string },
  orgId: string,
  file = pendingPairingCodesPath(),
): ReRegisteredDevice | undefined {
  const identity = typeof device === 'string' ? { name: device } : device;
  return Object.values(readStore(file).reRegistered)
    .filter((record) => record.orgId === orgId && sameDevice(record, identity))
    .sort((a, b) => parseTime(b.at) - parseTime(a.at))[0];
}

/** What to tell an operator whose kept code a later re-register has killed. Nothing here can revive it. */
export function describeInvalidatedPairingCode(pending: PendingPairingCode, reRegistered: ReRegisteredDevice): string {
  return [
    `the code kept for ${pending.name} was minted ${pending.mintedAt.slice(0, 16)}, but 'cihub fleet devices re-register' at ${reRegistered.at.slice(0, 16)} replaced it — Portal accepts only the newest.`,
    'Pass the code that re-register printed with --code, or re-register again and rerun.',
  ].join(' ');
}

/**
 * What to tell an operator whose mint got a 409. The name is taken, and there are exactly two
 * reasons; only a person in Portal can tell which, so both are named — unless this machine
 * re-registered the device, in which case the reason is known and so is the fix.
 */
export function describeDeviceNameConflict(name: string, reRegistered?: ReRegisteredDevice): string {
  if (reRegistered) {
    return [
      `a device named "${name}" already exists in this org: 'cihub fleet devices re-register' minted it a replacement code at ${reRegistered.at.slice(0, 16)},`,
      'but no roster node carried that code here. Pass the code re-register printed with --code, or re-register again and rerun.',
    ].join(' ');
  }
  return [
    `a device named "${name}" already exists in this org.`,
    'Either an earlier attempt minted it and failed before registering — delete it in Portal and rerun —',
    'or this node is registered under another org, whose owner must release it there first.',
  ].join(' ');
}

/**
 * Whether a `hub up + register` step's failure detail is Portal itself declaring the pairing code
 * dead, rather than a step that might still succeed with the same code on retry (a slow tunnel
 * provisioning timeout, a transient SSH/network failure). Matched against `describeStepFailure`'s
 * output, which keeps the tail of `cihub register`'s own stdout — Portal's literal response body is
 * `{"error":"That pairing code is no longer valid. Ask for a new one.","code":"PAIRING_CODE_INVALID",...}`
 * and the CLI prints its `error` field verbatim under a "Pairing failed" heading.
 *
 * A true result here is the caller's cue to `clearPendingPairingCode` so the next attempt mints a
 * fresh code instead of resending one Portal has already refused — see the module doc for why every
 * other failure must NOT clear the kept code.
 */
export function isDeadPairingCodeFailure(detail: string): boolean {
  return /pairing code is no longer valid/i.test(detail) || /PAIRING_CODE_INVALID/.test(detail);
}
