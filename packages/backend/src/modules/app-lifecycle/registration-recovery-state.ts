import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import type { RehydrationStateFile } from './app-rehydration';

const restoreIntentPath = () => path.join(DATA_DIR, 'state', 'restore-intent.json');
const rehydrationStatePath = () => path.join(DATA_DIR, 'state', 'rehydration.json');

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
