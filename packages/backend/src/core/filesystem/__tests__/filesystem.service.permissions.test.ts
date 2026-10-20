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

  describe('findUnreadable', () => {
    it('finds the database file a copy would stop at, a level down', async () => {
      const { dataDir, secretFile } = await makeDatabaseDataDir();

      await expect(service.findUnreadable(dataDir)).resolves.toEqual([secretFile]);
    });

    it('finds a folder it cannot list', async () => {
      const dataDir = path.join(scratch, 'app-data');
      const locked = path.join(dataDir, 'pgdata');
      await fs.promises.mkdir(locked, { recursive: true });
      await fs.promises.chmod(locked, 0o000);

      await expect(service.findUnreadable(dataDir)).resolves.toEqual([locked]);
    });

    it('returns nothing for a folder it can read all of, and for one that does not exist', async () => {
      const dataDir = path.join(scratch, 'ok');
      await fs.promises.mkdir(path.join(dataDir, 'sub'), { recursive: true });
      await fs.promises.writeFile(path.join(dataDir, 'sub', 'a.txt'), 'a');

      await expect(service.findUnreadable(dataDir)).resolves.toEqual([]);
      await expect(service.findUnreadable(path.join(scratch, 'missing'))).resolves.toEqual([]);
    });

    it('stops at maxFound and does not follow symbolic links', async () => {
      const dataDir = path.join(scratch, 'many');
      await fs.promises.mkdir(dataDir, { recursive: true });
      for (const n of ['a', 'b', 'c', 'd']) {
        const file = path.join(dataDir, n);
        await fs.promises.writeFile(file, n);
        await fs.promises.chmod(file, 0o000);
      }
      const locked = path.join(scratch, 'locked-elsewhere');
      await fs.promises.mkdir(locked);
      await fs.promises.chmod(locked, 0o000);
      await fs.promises.symlink(locked, path.join(dataDir, 'link'));

      const found = await service.findUnreadable(dataDir, { maxFound: 2 });

      expect(found).toHaveLength(2);
      expect(found.every((f) => !f.endsWith('link') && !f.includes('locked-elsewhere'))).toBe(true);
    });

    it('looks at no more than maxEntries entries', async () => {
      const dataDir = path.join(scratch, 'bounded');
      await fs.promises.mkdir(dataDir, { recursive: true });
      for (let i = 0; i < 20; i++) await fs.promises.writeFile(path.join(dataDir, `ok-${i}`), 'x');
      const late = path.join(dataDir, 'zz-locked');
      await fs.promises.writeFile(late, 'x');
      await fs.promises.chmod(late, 0o000);

      await expect(service.findUnreadable(dataDir, { maxEntries: 5 })).resolves.toEqual([]);
      await expect(service.findUnreadable(dataDir, { maxEntries: 100 })).resolves.toEqual([late]);
    });
  });

  // The layout of a native-Linux Hub container: /data is root-owned (here: not writable by the test
  // user) and only its subfolders are mounted from the host and owned by the Hub's user.
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
