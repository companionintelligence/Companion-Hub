import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import type { RehydrationStateFile } from './app-rehydration';

const restoreIntentPath = () => path.join(DATA_DIR, 'state', 'restore-intent.json');
const rehydrationStatePath = () => path.join(DATA_DIR, 'state', 'rehydration.json');
const pairingAppCheckPath = () => path.join(DATA_DIR, 'state', 'pairing-app-check.json');

/**
 * The apps check a pairing leaves for `PairingAppRestoreService`, and the hold it puts on app sync.
 *
 * While this file exists, `ExposureSyncService.triggerCloudflareSync` sends nothing. A sync names every
 * app this Hub serves, and Companion Portal releases each app on the device that it leaves out, so the
 * first sync after pairing back onto an existing device, from a Hub that has not reinstalled its apps,
 * would release all of them.
 */
export interface PairingAppCheckFile {
  markedAt: string;
  /**
   * Set once the Portal listed apps this Hub does not have and their restore began. `portalAppNames` is
   * that list, so the hold lasts until those installs settle, not only until they are queued.
   */
  restore?: { startedAt: string; portalAppNames: string[] };
}

export async function writeRestoreIntent(): Promise<void> {
  await fs.mkdir(path.dirname(restoreIntentPath()), { recursive: true });
  await fs.writeFile(restoreIntentPath(), JSON.stringify({ markedAt: new Date().toISOString() }, null, 2), 'utf-8');
}

export async function hasRestoreIntent(): Promise<boolean> {
  try {
    await fs.access(restoreIntentPath());
    return true;
  } catch {
    return false;
  }
}

export async function clearRestoreIntent(): Promise<void> {
  try {
    await fs.unlink(restoreIntentPath());
  } catch {
    // already cleared
  }
}

/** Starts a new check after a pairing, replacing whatever an earlier pairing left. */
export async function writePairingAppCheck(state: PairingAppCheckFile = { markedAt: new Date().toISOString() }): Promise<void> {
  await fs.mkdir(path.dirname(pairingAppCheckPath()), { recursive: true });
  await fs.writeFile(pairingAppCheckPath(), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Whether app sync is held for a pairing's apps check.
 *
 * Asks only whether the file exists: one that cannot be parsed still holds the sync, because releasing
 * apps is the thing it is there to prevent.
 */
export async function hasPairingAppCheck(): Promise<boolean> {
  try {
    await fs.access(pairingAppCheckPath());
    return true;
  } catch {
    return false;
  }
}

/** The pending check, or `null` when there is none. A file that cannot be parsed reads as a check not yet begun. */
export async function readPairingAppCheck(): Promise<PairingAppCheckFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(pairingAppCheckPath(), 'utf-8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PairingAppCheckFile>;
    const restore = parsed.restore;
    return {
      markedAt: typeof parsed.markedAt === 'string' ? parsed.markedAt : new Date().toISOString(),
      ...(restore && typeof restore.startedAt === 'string' && Array.isArray(restore.portalAppNames)
        ? { restore: { startedAt: restore.startedAt, portalAppNames: restore.portalAppNames.filter((name) => typeof name === 'string') } }
        : {}),
    };
  } catch {
    return { markedAt: new Date().toISOString() };
  }
}

export async function clearPairingAppCheck(): Promise<void> {
  try {
    await fs.unlink(pairingAppCheckPath());
  } catch {
    // already cleared
  }
}

export async function readRehydrationState(): Promise<RehydrationStateFile | null> {
  try {
    const raw = await fs.readFile(rehydrationStatePath(), 'utf-8');
    return JSON.parse(raw) as RehydrationStateFile;
  } catch {
    return null;
  }
}

export async function writeRehydrationState(state: RehydrationStateFile): Promise<void> {
  await fs.mkdir(path.dirname(rehydrationStatePath()), { recursive: true });
  await fs.writeFile(rehydrationStatePath(), JSON.stringify(state, null, 2), 'utf-8');
}

export async function clearRehydrationState(): Promise<void> {
  try {
    await fs.unlink(rehydrationStatePath());
  } catch {
    // already cleared
  }
}

export async function clearRegistrationRecoveryArtifacts(): Promise<void> {
  await Promise.all([clearRestoreIntent(), clearRehydrationState()]);
}
