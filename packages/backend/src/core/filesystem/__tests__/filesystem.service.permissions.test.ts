import os from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@/core/logger/logger.service';

// Real permission bits: the memfs mock the suite installs ignores them, so it cannot express the
// failure that stopped every app update on a native-Linux Hub (a Hub running as a plain user cannot
// read files a container created under another user, or create a folder in a root-owned /data).
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('../filesystem.service');

// root ignores permission bits, and Windows has none to speak of; on those the checks below would prove nothing.
const canEnforcePermissions = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

describe.skipIf(!canEnforcePermissions)('FilesystemService and permissions it really enforces', () => {
  let scratch: string;
  let service: InstanceType<typeof FilesystemService>;

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fs-perms-'));
    service = new FilesystemService(mock<LoggerService>());
  });

  afterEach(async () => {
    // Put the bits back so the scratch folder can be removed.
    await fs.promises.chmod(scratch, 0o755).catch(() => undefined);
    for (const name of await fs.promises.readdir(scratch).catch(() => [] as string[])) {
      await fs.promises.chmod(path.join(scratch, name), 0o755).catch(() => undefined);
    }
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  /** A database-shaped data folder: `mysql/ibdata1` that only its own container's user can read. */
  async function makeDatabaseDataDir(): Promise<{ dataDir: string; secretFile: string }> {
    const dataDir = path.join(scratch, 'app-data', 'store', 'app');
    await fs.promises.mkdir(path.join(dataDir, 'mysql'), { recursive: true });
    await fs.promises.writeFile(path.join(dataDir, 'readable.txt'), 'fine');
    const secretFile = path.join(dataDir, 'mysql', 'ibdata1');
    await fs.promises.writeFile(secretFile, 'database bytes');
    await fs.promises.chmod(secretFile, 0o000);
    return { dataDir, secretFile };
  }

  describe('copyDirectoryDetailed', () => {
    it('copies a readable folder', async () => {
      const src = path.join(scratch, 'src');
      await fs.promises.mkdir(src);
      await fs.promises.writeFile(path.join(src, 'a.txt'), 'a');

      await expect(service.copyDirectoryDetailed(src, path.join(scratch, 'dest'))).resolves.toEqual({ copied: true, permissionDenied: false });
      await expect(fs.promises.readFile(path.join(scratch, 'dest', 'a.txt'), 'utf8')).resolves.toBe('a');
    });

    it('says permissionDenied, not just false, when a file belongs to someone else', async () => {
      const { dataDir } = await makeDatabaseDataDir();

      await expect(service.copyDirectoryDetailed(dataDir, path.join(scratch, 'snapshot'))).resolves.toEqual({
        copied: false,
        permissionDenied: true,
      });
      // copyDirectory keeps answering with the plain boolean its callers use.
      await expect(service.copyDirectory(dataDir, path.join(scratch, 'snapshot2'))).resolves.toBe(false);
    });

    it('does not call a missing source a permission problem', async () => {
      const result = await service.copyDirectoryDetailed(path.join(scratch, 'nope'), path.join(scratch, 'dest'));

      expect(result).toEqual({ copied: false, permissionDenied: false });
    });
  });

  /*
   * The detailed variants are for callers that hand a permission failure to a root helper and report
   * the outcome themselves. An error line from the first try put a red line in the Logs tab for every
   * restore, reset or backup that then worked as root.
   */
  describe('what a permission failure logs', () => {
    let logger: ReturnType<typeof mock<LoggerService>>;

    beforeEach(() => {
      logger = mock<LoggerService>();
      service = new FilesystemService(logger);
    });

    it('is debug only from removeDirectoryDetailed but still an error from removeDirectory', async () => {
      const locked = path.join(scratch, 'locked');
      await fs.promises.mkdir(locked);
      await fs.promises.writeFile(path.join(locked, 'kuma.db'), 'x');
      await fs.promises.chmod(locked, 0o555);

      await expect(service.removeDirectoryDetailed(locked)).resolves.toEqual({ removed: false, permissionDenied: true });
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining(`Could not remove ${locked}`), expect.anything());

      await expect(service.removeDirectory(locked)).resolves.toBe(false);
      expect(logger.error).toHaveBeenCalledWith(`Error removing directory ${locked}:`, expect.anything());
    });

    it('is debug only from copyDirectoryDetailed but still an error from copyDirectory', async () => {
      const { dataDir } = await makeDatabaseDataDir();

      await service.copyDirectoryDetailed(dataDir, path.join(scratch, 'copy'));
      expect(logger.error).not.toHaveBeenCalled();

      await service.copyDirectory(dataDir, path.join(scratch, 'copy2'));
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('stays an error for a failure that is not about permissions', async () => {
      await service.copyDirectoryDetailed(path.join(scratch, 'nope'), path.join(scratch, 'dest'));

      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('a data folder the Hub cannot write to, with a writable backups folder inside it', () => {
    it('cannot create a folder directly under it (what the old snapshot location did) but can under backups/', async () => {
      const dataDir = path.join(scratch, 'data');
      await fs.promises.mkdir(path.join(dataDir, 'backups'), { recursive: true });
      await fs.promises.chmod(dataDir, 0o555);

      await expect(service.createDirectory(path.join(dataDir, 'snapshots', 'store', 'app'))).resolves.toBe(false);
      await expect(service.createDirectory(path.join(dataDir, 'backups', '.pre-update-snapshots', 'store', 'app'))).resolves.toBe(true);
    });
  });
});
