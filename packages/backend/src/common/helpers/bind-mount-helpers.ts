import fs from 'node:fs';
import path from 'node:path';

function isFsErrorWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === code);
}

/** Rename a stale bind-mounted path aside for manual recovery instead of deleting it. Keep in sync with scripts/heal-hub-bind-mounts.ts quarantineStalePath. */
export function quarantineStalePath(targetPath: string, reason = 'stale-root'): string | null {
  if (!fs.existsSync(targetPath)) return null;

  const quarantinePath = `${targetPath}.${reason}-${Date.now()}`;
  try {
    fs.renameSync(targetPath, quarantinePath);
    return quarantinePath;
  } catch {
    return null;
  }
}

/** Ensure a bind-mounted directory exists and is writable by the Hub process. */
export async function ensureWritableDirectory(dirPath: string, mode = 0o775): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true, mode });
  try {
    await fs.promises.chmod(dirPath, mode);
  } catch {
    // chmod may fail on some mounts; file-level retry still applies.
  }
}

async function retryWritableFile(filePath: string, fileMode: number): Promise<void> {
  const dirPath = path.dirname(filePath);
  await ensureWritableDirectory(dirPath);

  try {
    await fs.promises.chmod(dirPath, 0o777);
  } catch {
    // Host user may not own a root-created directory.
  }

  if (!fs.existsSync(filePath)) {
    return;
  }

  try {
    await fs.promises.chmod(filePath, fileMode);
    await fs.promises.access(filePath, fs.constants.W_OK);
    return;
  } catch {
    quarantineStalePath(filePath);
  }
}

/** Heal stale root-owned bind-mount files before tunnel/Traefik writes. */
export async function ensureWritableFile(filePath: string, fileMode = 0o644): Promise<void> {
  await ensureWritableDirectory(path.dirname(filePath));

  if (!fs.existsSync(filePath)) {
    return;
  }

  try {
    await fs.promises.access(filePath, fs.constants.W_OK);
  } catch {
    await retryWritableFile(filePath, fileMode);
  }
}

/** Write a bind-mounted file with permission recovery for stale root-owned paths. */
export async function writeHealableTextFile(filePath: string, content: string, fileMode = 0o644): Promise<void> {
  await ensureWritableFile(filePath, fileMode);

  try {
    await fs.promises.writeFile(filePath, content, { encoding: 'utf8', mode: fileMode });
  } catch (error) {
    if (!isFsErrorWithCode(error, 'EACCES')) {
      throw error;
    }
    await retryWritableFile(filePath, fileMode);
    await fs.promises.writeFile(filePath, content, { encoding: 'utf8', mode: fileMode });
  }
}

const posixPermissionSupport = new Map<string, boolean>();

/**
 * Windows-backed bind mounts (drvfs/9p) accept chmod/chown and silently discard them. A container
 * that must own its data directory — postgres' `initdb`, mysql's `mysqld` — then aborts with EPERM
 * on first start. Probe by flipping the mode on a scratch file and reading it back: a filesystem
 * that cannot carry permissions cannot host those data directories either.
 *
 * A failed probe reports "supported" on purpose. Reporting the opposite would relocate an app's
 * data directory into a fresh named volume, so on the platforms where bind mounts already work we
 * would strand existing data over what may be a transient IO error.
 *
 * Cached per directory: a mounted filesystem does not change its permission semantics underneath a
 * running Hub, and the Hub process restarts on update.
 */
export async function supportsPosixPermissions(dirPath: string): Promise<boolean> {
  const cached = posixPermissionSupport.get(dirPath);
  if (cached !== undefined) {
    return cached;
  }

  const supported = await probePosixPermissions(dirPath);
  posixPermissionSupport.set(dirPath, supported);
  return supported;
}

async function probePosixPermissions(dirPath: string): Promise<boolean> {
  const probePath = path.join(dirPath, `.ci-hub-permission-probe-${process.pid}-${Date.now()}`);

  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
    await fs.promises.writeFile(probePath, '', { mode: 0o600 });
    await fs.promises.chmod(probePath, 0o640);
    const stats = await fs.promises.stat(probePath);
    return (stats.mode & 0o777) === 0o640;
  } catch {
    return true;
  } finally {
    // try/catch, not `.catch()`: anything thrown from a finally block replaces the value the
    // function already decided on, so a cleanup failure would propagate out of a probe whose
    // whole contract is never to throw.
    try {
      await fs.promises.unlink(probePath);
    } catch {
      /* probe file may never have been created */
    }
  }
}

/** Test seam — the probe result is cached for the life of the process. */
export function resetPosixPermissionSupportCache(): void {
  posixPermissionSupport.clear();
}

export function readTextFileIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}
