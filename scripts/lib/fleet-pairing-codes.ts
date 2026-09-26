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
 * failure is the only signal available, so a step whose output names a Portal answer about the code
 * clears the kept code — see `classifyPairingFailure` — while every other failure (a dropped SSH
 * session, a node that never came up, a Portal the machine could not reach at all) still keeps it,
 * exactly as before: those may yet succeed with the same code, and re-minting on every failure is
 * what caused the 2026-09-18 orphan-device incident this file exists to prevent.
 *
 * A slow tunnel/DNS provisioning step is NOT one of the keep-it failures, though it reads like one.
 * Portal claims the code when it validates it and provisions afterwards, so `#1580`'s timeout copy
 * says "Get a new pairing code before trying again" and the DNS error from #1582 was followed by a
 * `410` on the very same code. Those answers spend the code without registering the Hub; keeping it
 * would buy the next run a twenty-minute `hub up` ending in the 410 it was trying to avoid.
 *
 * A kept code can also just be old. On 2026-09-26 core-6's install went out with "reusing the code
 * minted 2026-09-23T03:14" — three days on, with nothing on the line to say the code was older than
 * the run. A kept code exists to bridge a retry, so one older than `MAX_PENDING_PAIRING_CODE_AGE_MS`
 * is replaced where the run can replace it, and every reuse says how old the code is. It stays kept
 * until the replacement is in hand: it is the only record of the device id a re-register needs, and
 * Portal may still honour it — up to `PORTAL_PAIRING_CODE_TTL_MS`, which is what a login that cannot
 * re-register falls back on. A release (`fleet devices release`) forgets the device's codes outright:
 * the row they belonged to is gone, so none of them can pair.
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

/**
 * How long a kept code is reused before `fleet install` tries to replace it with a fresh one.
 *
 * Portal's own lifetime (`PORTAL_PAIRING_CODE_TTL_MS`) is the ceiling, not the target. Nothing in the
 * mint response carries it, so this side cannot learn it per code. A day sits well inside it for
 * three reasons:
 *
 * - The store's job is to bridge a retry. A code a day old belongs to an attempt nobody retried
 *   that day, and the Portal state it was minted against — the device row, a release, a re-register
 *   from another machine — is no longer anything this machine can vouch for. core-1's code that
 *   failed at register on 2026-09-20 had been kept since the day before.
 * - A dead code is only found out at `register`, after a `hub up` of up to twenty minutes, so the
 *   check has to run before that, on age alone.
 * - Portal's seven days may shrink without this CLI shipping; a day survives any plausible cut.
 *
 * Past it the code is replaced, not discarded: a replacement can fail, and a `device:pair` login
 * cannot get one at all while the device row still exists. Either way the old code is still the
 * best one on hand, so it is kept until a fresh one is.
 */
export const MAX_PENDING_PAIRING_CODE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How long Portal honours a pairing code: CI-Portal's `PAIRING_CODE_TTL_MS` (`DeviceService.ts`,
 * migration 0060, 2026-09-10), mirrored because the mint response does not carry it. Expiry is part
 * of Portal's claim, so a code past it fails at `register`, but the device row it was minted with
 * outlives it, so a fresh mint still answers 409. Portal's comment calls the number a guess to be
 * shortened; if it is, a code sent under this bound fails at `register` as any dead code does.
 *
 * `fleet install` uses it for the one case where it cannot replace an old code: the device row
 * still exists and the login is `device:pair`, which cannot re-register. Under this age the code is
 * sent, with its age on the line; past it, sending it would buy a twenty-minute `hub up` ending in a
 * refusal, so the node stops instead.
 */
export const PORTAL_PAIRING_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long ago the code was minted (or re-registered). An unparseable `mintedAt` is infinitely old:
 * a code whose age cannot be read cannot be shown to be young enough to send.
 */
export function pendingPairingCodeAgeMs(pending: Pick<PendingPairingCode, 'mintedAt'>, now = Date.now()): number {
  const minted = Date.parse(pending.mintedAt);
  return Number.isNaN(minted) ? Number.POSITIVE_INFINITY : Math.max(0, now - minted);
}

/** `3d 2h`, `5h 12m`, `14m` — an age an operator reads at a glance, precise enough to spot "days". */
export function describePairingCodeAge(ms: number): string {
  if (!Number.isFinite(ms)) return 'an unknown time';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  const mins = minutes % 60;
  if (hours > 0) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
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
 * Forget everything kept for a device Portal has just deleted: its codes, at any address, and the
 * record of any re-register. A code for a deleted row can never pair, so keeping it only buys the
 * next `fleet install` a twenty-minute `hub up` ending in a 410 — and a re-register record would
 * explain the fresh device's name conflict with a code that no longer exists. Returns the codes
 * dropped, for the caller to mention.
 */
export function forgetReleasedDevice(
  device: { id: string; name: string; slug?: string },
  orgId: string,
  file = pendingPairingCodesPath(),
): PendingPairingCode[] {
  const store = readStore(file);
  const identity = { deviceId: device.id, name: device.name, slug: device.slug };
  const codes = Object.values(store.codes).filter((entry) => entry.orgId === orgId && sameDevice(entry, identity));
  const records = Object.entries(store.reRegistered).filter(([, record]) => record.orgId === orgId && sameDevice(record, identity));
  if (codes.length === 0 && records.length === 0) return [];
  for (const entry of codes) delete store.codes[entry.ip];
  for (const [key] of records) delete store.reRegistered[key];
  writeStore(file, store);
  return codes;
}

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
 * What `fleet install` would do with the code kept for a node, decided once so the dry run's plan and
 * the run itself cannot disagree. Reads the store and nothing else; changes nothing.
 */
export type KeptPairingCode =
  | { kind: 'none' }
  | { kind: 'reuse'; pending: PendingPairingCode; ageMs: number }
  | { kind: 'too-old'; pending: PendingPairingCode; ageMs: number }
  | { kind: 'invalidated'; pending: PendingPairingCode; reRegistered: ReRegisteredDevice };

export function assessKeptPairingCode(ip: string, orgId: string, options: { now?: number; file?: string } = {}): KeptPairingCode {
  const file = options.file ?? pendingPairingCodesPath();
  const pending = readPendingPairingCode(ip, orgId, file);
  if (!pending) return { kind: 'none' };
  // Checked before age: it names the exact reason and the exact code to send instead.
  const reRegistered = findInvalidatingReRegistration(pending, file);
  if (reRegistered) return { kind: 'invalidated', pending, reRegistered };
  const ageMs = pendingPairingCodeAgeMs(pending, options.now);
  return ageMs <= MAX_PENDING_PAIRING_CODE_AGE_MS ? { kind: 'reuse', pending, ageMs } : { kind: 'too-old', pending, ageMs };
}

/** `the code minted 2026-09-23T03:14 for core-6 (3d 2h ago)` — what every line about a kept code says. */
export function describeKeptPairingCode(pending: PendingPairingCode, ageMs: number): string {
  const origin = pending.reRegisteredAt ? 're-registered' : 'minted';
  return `the code ${origin} ${pending.mintedAt.slice(0, 16)} for ${pending.slug} (${describePairingCodeAge(ageMs)} ago)`;
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
 * What a failed `hub up + register` proves about the code it sent.
 *
 * `refused` — Portal never accepted it. The code is dead and nothing this file keeps can revive it,
 * but the device row it belongs to is still there, so a re-register mints a replacement worth
 * sending. On 2026-09-22 fifteen nodes failed this way and `fleet install` handed the same dead code
 * back on every retry, including after the devices were released, because nothing here ever read the
 * refusal (CI-Hub#1582).
 *
 * `claimed` — Portal took the code and then failed: the DNS/tunnel provisioning that follows pairing,
 * or an answer that never arrived. The code is spent either way — Portal claims it before it
 * provisions — so keeping it is wrong, and so is minting a replacement, which meets the same wall.
 * That is the loop beta-max was in: every attempt burned a fresh code on a failure that was never
 * about the code.
 *
 * Anything else — `hub up` died before `register`, the Portal was unreachable, docker refused —
 * leaves the code unspent and is not this function's business: it returns undefined and the kept
 * code stays kept.
 */
export type PairingCodeOutcome = { kind: 'refused' | 'claimed'; why: string };

export function classifyPairingFailure(output: string): PairingCodeOutcome | undefined {
  const text = output.replace(/\s+/g, ' ');
  // Checked first: `cihub register` prints this box only after Portal has answered the pair, so
  // whatever went wrong below it went wrong with the code already spent.
  if (/Pairing accepted/i.test(text)) return { kind: 'claimed', why: 'Portal accepted the code and the registration failed after it' };
  if (/DNS provider error/i.test(text)) return { kind: 'claimed', why: 'Portal accepted the code and then failed to create the DNS record' };
  if (/did not answer in time/i.test(text)) return { kind: 'claimed', why: 'Portal took the code and never answered, so it may be provisioning' };
  if (/incomplete registration data/i.test(text))
    return { kind: 'claimed', why: 'Portal accepted the code and answered with incomplete registration data' };
  if (/no longer valid|PAIRING_CODE_INVALID|Ask for a new one/i.test(text))
    return { kind: 'refused', why: 'Portal refused the code as no longer valid' };
  if (/PAIRING_CODE_WRONG_DEVICE|code is for another device/i.test(text))
    return { kind: 'refused', why: 'Portal says that code belongs to another device' };
  // The wipe destroyed the key that proves this machine owns the device row, and a keyless re-pair
  // is refused. An owner-led re-register is exactly the fix, and it arrives with a new code.
  if (/DEVICE_PROOF_REQUIRED/i.test(text))
    return { kind: 'refused', why: 'Portal wants proof this machine owns the device row, which only a re-register gives' };
  return undefined;
}

/**
 * Whether a register step's failure detail is Portal declaring the code dead — the narrower question
 * `#1584` asked, kept as its own name because that is what reads at a call site that only wants to
 * stop keeping the code. It is `classifyPairingFailure` and not a second pair of patterns: two
 * regexes for one Portal answer drift, and the first thing to drift would be the one nobody notices.
 *
 * A code Portal *claimed* and then failed on is not "dead" by this name and still must not be kept —
 * `classifyPairingFailure` is the one to ask when that distinction matters.
 */
export function isDeadPairingCodeFailure(detail: string): boolean {
  return classifyPairingFailure(detail)?.kind === 'refused';
}
