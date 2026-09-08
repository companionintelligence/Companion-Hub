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

  it('refuses a name that is only a segment after trimming', () => {
    // Trimmed first, so surrounding whitespace cannot smuggle a different name
    // past the single-segment test.
    expect(resolveBackupFilePath(backupDir, '  backup.tar.gz  ')).toBe(path.join(backupDir, 'backup.tar.gz'));
  });
});
