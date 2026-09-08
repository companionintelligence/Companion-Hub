import path from 'node:path';

/**
 * Resolve a caller-supplied backup filename inside an app's own backup
 * directory, or throw.
 *
 * ⚠ `FilesystemService.getSafeFilePath` IS NOT THIS CHECK, AND THAT IS WHY
 * EVERY BACKUP METHOD WAS TRAVERSABLE. It fences a path to a set of ROOTS —
 * `APP_DIR`, `APP_DATA_DIR`, `DATA_DIR`, tmp — so `path.join(backupDir,
 * '../../../.env')` resolves to `<dataDir>/.env`, which is inside `DATA_DIR` and
 * therefore passes. The fence was doing its job; it was simply asked the wrong
 * question. What matters here is not "is this somewhere we own" but "is this
 * THIS APP's backup".
 *
 * The consequence was a read of `/data/.env` through `GET /api/backups/:urn`'s
 * download path, and a write over any app's `docker-compose.yml` through the
 * upload path — from a route whose parameters are a URN and a filename.
 *
 * ⚠ THE NAME IS REJECTED, NOT SANITISED. Stripping separators out of a filename
 * invents a different name than the caller asked for, which for a delete or a
 * restore means acting on a file nobody named. A backup filename is produced by
 * this system and is always a single path segment; anything else is a caller
 * doing something other than naming a backup.
 *
 * Containment is asserted after resolution as well, so a name that is a single
 * segment by inspection but not by `path` — a platform quirk, an encoding — is
 * still caught by the property that actually matters.
 */
export function resolveBackupFilePath(backupDir: string, filename: string): string {
  const name = filename?.trim();

  if (!name) {
    throw new Error('A backup filename is required');
  }

  // `path.basename` is the definition of "one segment", on both separator
  // conventions, and `.`/`..` are names `basename` happily returns.
  if (name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error('Invalid backup filename');
  }

  // A NUL truncates the path at the syscall boundary, so a name containing one
  // can name a different file than the one that was checked.
  if (name.includes('\0')) {
    throw new Error('Invalid backup filename');
  }

  const resolvedDir = path.resolve(backupDir);
  const resolved = path.resolve(resolvedDir, name);
  const relative = path.relative(resolvedDir, resolved);

  if (!relative || path.isAbsolute(relative) || relative.startsWith('..')) {
    throw new Error('Invalid backup filename');
  }

  return resolved;
}
