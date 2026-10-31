import { describe, expect, it } from 'vitest';
import {
  managedVolumeCleanupCommand,
  resolveManagedPosixVolumeName,
  resolvePosixVolumeFallback,
  shouldUseManagedPosixVolume,
} from '../qa-managed-volume';

describe('managed POSIX-volume fallback selection', () => {
  it('defaults on for macOS and Windows, and off for Linux', () => {
    expect(resolvePosixVolumeFallback('darwin')).toBe(true);
    expect(resolvePosixVolumeFallback('win32')).toBe(true);
    expect(resolvePosixVolumeFallback('linux')).toBe(false);
  });

  it('honors an explicit enable or disable override on every platform', () => {
    expect(resolvePosixVolumeFallback('linux', '1')).toBe(true);
    expect(resolvePosixVolumeFallback('darwin', '0')).toBe(false);
    expect(resolvePosixVolumeFallback('linux', 'true')).toBe(false);
  });

  it('selects only unseeded host paths that explicitly require POSIX permissions', () => {
    const volume = { hostPath: '${APP_DATA_DIR}/data/db', requiresPosixPermissions: true };
    expect(shouldUseManagedPosixVolume(volume, true, false)).toBe(true);
    expect(shouldUseManagedPosixVolume(volume, false, false)).toBe(false);
    expect(shouldUseManagedPosixVolume(volume, true, true)).toBe(false);
    expect(shouldUseManagedPosixVolume({ hostPath: volume.hostPath }, true, false)).toBe(false);
    expect(shouldUseManagedPosixVolume({ requiresPosixPermissions: true }, true, false)).toBe(false);
  });
});

describe('managed POSIX-volume naming and cleanup', () => {
  const volume = { hostPath: '${APP_DATA_DIR}/data/db', requiresPosixPermissions: true };

  it('reuses a name within a run and creates a different name for the next run', () => {
    const firstRunVolumes = new Map<string, string>();
    const first = resolveManagedPosixVolumeName(volume, 'qa-stream-my-app', 'run-1', true, false, firstRunVolumes);
    const repeated = resolveManagedPosixVolumeName(volume, 'qa-stream-my-app', 'run-1', true, false, firstRunVolumes);
    const nextRun = resolveManagedPosixVolumeName(volume, 'qa-stream-my-app', 'run-2', true, false, new Map());

    expect(first).toMatch(/^qa-qa-stream-my-app-[a-f0-9]{16}$/);
    expect(repeated).toBe(first);
    expect(nextRun).not.toBe(first);
  });

  it('creates cleanup only for explicit run-scoped QA volumes', () => {
    const name = resolveManagedPosixVolumeName(volume, 'qa-stream-my-app', 'run-1', true, false, new Map());
    if (!name) throw new Error('expected a managed volume name');
    expect(managedVolumeCleanupCommand([name, name])).toBe(`docker volume rm -f ${name}`);
    expect(managedVolumeCleanupCommand([])).toBeNull();
    expect(() => managedVolumeCleanupCommand(['app-data'])).toThrow(/run-scoped QA name/);
    expect(() => managedVolumeCleanupCommand(['qa-app-data'])).toThrow(/run-scoped QA name/);
  });
});
