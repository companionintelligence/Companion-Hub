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

const posixPermissionSupport = new Map<string, Promise<boolean>>();

/** Records the last measured answer so a later failed probe does not contradict it. */
const PERMISSION_VERDICT_FILE = '.ci-hub-fs-permissions';

/**
 * Windows-backed bind mounts (drvfs/9p) accept chmod/chown and silently discard them. A container
 * that must own its data directory — postgres' `initdb`, mysql's `mysqld` — then aborts with EPERM
 * on first start. Probe by flipping the mode on a scratch file and reading it back: a filesystem
 * that cannot carry permissions cannot host those data directories either.
 *
 * The answer decides where an app's data lives, so a probe that cannot measure must never
 * contradict one that could. Each successful measurement is recorded next to the directory and
 * reused when a later probe fails; only a filesystem that has never been measured falls back to
 * "supported". Without that record, one transient IO error on a Windows Hub would re-render the
 * compose file with the bind mount restored, and postgres would `initdb` an empty directory while
 * the real database sat in a named volume nothing referenced any more.
 *
 * The in-flight promise is cached, not the resolved value: lifecycle events run concurrently, and
 * caching after the await would let every one of them run its own probe.
 */
export async function supportsPosixPermissions(dirPath: string): Promise<boolean> {
  const inFlight = posixPermissionSupport.get(dirPath);
  if (inFlight !== undefined) {
    return inFlight;
  }

  const pending = resolvePosixPermissions(dirPath);
  posixPermissionSupport.set(dirPath, pending);
  return pending;
}

async function resolvePosixPermissions(dirPath: string): Promise<boolean> {
  const measured = await probePosixPermissions(dirPath);
  if (measured !== undefined) {
    await recordPermissionVerdict(dirPath, measured);
    return measured;
  }

  return (await readPermissionVerdict(dirPath)) ?? true;
}

async function recordPermissionVerdict(dirPath: string, supported: boolean): Promise<void> {
  try {
    await fs.promises.writeFile(path.join(dirPath, PERMISSION_VERDICT_FILE), supported ? 'supported' : 'unsupported', 'utf-8');
  } catch {
    /* Losing the record only costs us the fallback on a future failed probe. */
  }
}

async function readPermissionVerdict(dirPath: string): Promise<boolean | undefined> {
  try {
    const recorded = (await fs.promises.readFile(path.join(dirPath, PERMISSION_VERDICT_FILE), 'utf-8')).trim();
    if (recorded === 'supported') return true;
    if (recorded === 'unsupported') return false;
  } catch {
    /* Never measured, or unreadable — the caller falls back to "supported". */
  }
  return undefined;
}

let probeSequence = 0;

/** `undefined` means the probe could not measure — distinct from measuring "not supported". */
async function probePosixPermissions(dirPath: string): Promise<boolean | undefined> {
  // The counter, not just pid+timestamp, is what guarantees uniqueness: concurrent installs can
  // probe within the same millisecond, and sharing a filename would let one probe unlink the
  // other's file mid-flight — which reads as a failure to measure.
  probeSequence += 1;
  const probePath = path.join(dirPath, `.ci-hub-permission-probe-${process.pid}-${Date.now()}-${probeSequence}`);

  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
    // 0o600 -> 0o640 flips a bit in each of the group/other nibbles, so a filesystem that reports a
    // fixed mode (drvfs forces 0o777) cannot coincidentally match the value we asked for.
    await fs.promises.writeFile(probePath, '', { mode: 0o600 });
    await fs.promises.chmod(probePath, 0o640);
    const stats = await fs.promises.stat(probePath);
    return (stats.mode & 0o777) === 0o640;
  } catch {
    return undefined;
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
