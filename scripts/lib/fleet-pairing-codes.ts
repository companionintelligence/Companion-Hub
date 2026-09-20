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
}

type Store = Record<string, PendingPairingCode>;

export function pendingPairingCodesPath(loginPath = loginFilePath()): string {
  return path.join(path.dirname(loginPath), 'fleet-pending-pairing-codes.json');
}

function readStore(file: string): Store {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
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
  const entry = readStore(file)[ip];
  return entry && entry.orgId === orgId ? entry : undefined;
}

export function savePendingPairingCode(entry: PendingPairingCode, file = pendingPairingCodesPath()): void {
  const store = readStore(file);
  store[entry.ip] = entry;
  writeStore(file, store);
}

/** Forget a code once `register` has verifiably spent it. */
export function clearPendingPairingCode(ip: string, file = pendingPairingCodesPath()): void {
  const store = readStore(file);
  if (!(ip in store)) return;
  delete store[ip];
  writeStore(file, store);
}

/**
 * What to tell an operator whose mint got a 409. The name is taken, and there are exactly two
 * reasons; only a person in Portal can tell which, so both are named.
 */
export function describeDeviceNameConflict(name: string): string {
  return [
    `a device named "${name}" already exists in this org.`,
    'Either an earlier attempt minted it and failed before registering — delete it in Portal and rerun —',
    'or this node is registered under another org, whose owner must release it there first.',
  ].join(' ');
}
