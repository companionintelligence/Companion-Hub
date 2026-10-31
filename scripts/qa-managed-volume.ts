import { createHash } from 'node:crypto';

export interface PosixVolumeDeclaration {
  hostPath?: string;
  requiresPosixPermissions?: boolean;
}

/** Default the fallback on where Docker bind mounts do not reliably preserve Linux ownership. */
export function resolvePosixVolumeFallback(platform: string, override?: string): boolean {
  if (override === undefined) return platform === 'darwin' || platform === 'win32';
  return override === '1';
}

/** Seeded source files/directories stay bind-mounted so the QA run retains their contents. */
export function shouldUseManagedPosixVolume(volume: PosixVolumeDeclaration, fallback: boolean, seeded: boolean): boolean {
  return volume.requiresPosixPermissions === true && fallback && Boolean(volume.hostPath) && !seeded;
}

/**
 * Resolve a Docker volume name scoped to this QA run, app container, and host path.
 * The caller's cache keeps repeated mounts of the same host path on one shared volume.
 */
export function resolveManagedPosixVolumeName(
  volume: PosixVolumeDeclaration,
  containerName: string,
  runId: string,
  fallback: boolean,
  seeded: boolean,
  volumesByHostPath: Map<string, string>,
): string | null {
  const hostPath = volume.hostPath ?? '';
  if (!shouldUseManagedPosixVolume(volume, fallback, seeded)) return null;

  const cached = volumesByHostPath.get(hostPath);
  if (cached) return cached;

  const stem =
    containerName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'app';
  const digest = createHash('sha256').update(`${runId}\0${containerName}\0${hostPath}`).digest('hex').slice(0, 16);
  const name = `qa-${stem}-${digest}`;
  volumesByHostPath.set(hostPath, name);
  return name;
}

const MANAGED_QA_VOLUME_NAME = /^qa-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{16}$/;

/** Build an explicit cleanup command; reject unscoped or non-QA volume names. */
export function managedVolumeCleanupCommand(volumeNames: Iterable<string>): string | null {
  const names = [...new Set(volumeNames)];
  if (!names.length) return null;
  if (names.some((name) => !MANAGED_QA_VOLUME_NAME.test(name))) {
    throw new Error('Refusing to remove a volume without a run-scoped QA name');
  }
  return `docker volume rm -f ${names.join(' ')}`;
}
