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

export function readTextFileIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}
