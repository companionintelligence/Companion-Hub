import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import type { TrainingJobManifest } from './training.types';

/**
 * The only folder a pool peer's manifest may name. The trainer this node starts reads those paths
 * here, and the rest of the data directory holds `.env`, TLS state and every app's backups.
 */
const PEER_TRAINING_DATA_DIR = path.resolve(DATA_DIR, 'training');

/** A bare prefix test would also pass a sibling such as `<root>-x`. */
function isSameOrInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Resolved the way the runner resolves it, so the path checked is the path the trainer opens. A path
 * outside the folder is refused before the disk is read, so the answer says nothing about what exists
 * there. A missing path, or one that leads out through a link, is refused the same way.
 */
async function mayPeerName(value: string): Promise<boolean> {
  const resolved = path.resolve(value);
  if (!isSameOrInside(PEER_TRAINING_DATA_DIR, resolved)) {
    return false;
  }
  try {
    const [realRoot, realPath] = await Promise.all([fs.promises.realpath(PEER_TRAINING_DATA_DIR), fs.promises.realpath(resolved)]);
    return isSameOrInside(realRoot, realPath);
  } catch {
    return false;
  }
}

/** The first manifest field that names a path a pool peer may not name, or null when there is none. */
export async function peerPathRefusal(manifest: TrainingJobManifest): Promise<string | null> {
  const named: Array<[field: string, value: string | undefined]> = [
    ['dataset.dataPath', manifest.dataset.dataPath],
    ['model.baseCheckpointPath', manifest.model.baseCheckpointPath],
  ];
  for (const [field, value] of named) {
    if (value !== undefined && !(await mayPeerName(value))) {
      return field;
    }
  }
  return null;
}
