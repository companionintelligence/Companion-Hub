import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBackupFilePath } from '../backup-path';

describe('resolveBackupFilePath', () => {
  const backupDir = path.join('/data', 'backups', 'ci-marketplace', 'immich');

  it('resolves an ordinary backup name inside the app directory', () => {
    expect(resolveBackupFilePath(backupDir, 'immich-2026-09-08.tar.gz')).toBe(path.join(backupDir, 'immich-2026-09-08.tar.gz'));
  });

  /*
   * ⚠ `getSafeFilePath` PASSED THESE, AND THAT IS THE WHOLE FINDING. It fences a
   * path to a set of ROOTS — `DATA_DIR` among them — so `path.join(backupDir,
   * '../../../.env')` resolves to `<dataDir>/.env`, which is inside `DATA_DIR`
   * and therefore allowed. The fence was answering "is this somewhere we own"
   * when the question is "is this THIS APP's backup".
   *
   * The consequence was a read of `/data/.env` through the download route and a
   * write over any app's `docker-compose.yml` through the upload route.
   */
  it.each([
    ['../../../.env', 'climbs out to the data dir'],
    ['../immich-other/backup.tar.gz', "reaches another app's backups"],
    ['nested/backup.tar.gz', 'names a subdirectory'],
    ['/etc/passwd', 'is absolute'],
    ['..', 'is the parent itself'],
    ['.', 'is the directory itself'],
    ['', 'is empty'],
    ['   ', 'is blank'],
    ['back\0up.tar.gz', 'contains a NUL that truncates at the syscall'],
  ])('refuses %j because it %s', (filename) => {
    expect(() => resolveBackupFilePath(backupDir, filename)).toThrow();
  });

  it('refuses a padded name rather than trimming it into a different file', () => {
    // Whitespace is a legal part of a filename, so trimming and then resolving the
    // trimmed name would act on `backup.tar.gz` when the caller named something else
    // — exactly the sanitising this function exists to avoid.
    expect(() => resolveBackupFilePath(backupDir, '  backup.tar.gz  ')).toThrow();
  });

  it('resolves a contained name that merely begins with dots', () => {
    // `relative.startsWith('..')` rejects this one too; escaping is `..` itself or
    // `..` followed by a separator, not any name whose first two characters are dots.
    expect(resolveBackupFilePath(backupDir, '..hidden.tar.gz')).toBe(path.join(backupDir, '..hidden.tar.gz'));
  });
});
