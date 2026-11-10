import os from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@/core/logger/logger.service';

// Real files and links: the memfs mock the suite installs cannot tell a link from what it points at.
vi.unmock('node:fs');
vi.unmock('fs');

const { base } = vi.hoisted(() => {
  const { mkdtempSync, realpathSync } = require('node:fs') as typeof import('node:fs');
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');

  return { base: mkdtempSync(nodePath.join(realpathSync(nodeOs.tmpdir()), 'fs-containment-')) };
});

vi.mock('@/common/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/constants')>()),
  DATA_DIR: path.join(base, 'data'),
  APP_DATA_DIR: path.join(base, 'app-data'),
  APP_DIR: path.join(base, 'install'),
}));

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('../filesystem.service');

describe('FilesystemService containment', () => {
  const data = path.join(base, 'data');
  const appData = path.join(base, 'app-data');
  const appOne = path.join(appData, 'store', 'app-one');
  const appTwo = path.join(appData, 'store', 'app-two');
  const hubFolder = path.join(data, 'hub-state');
  const otherFolder = path.join(data, 'configs');
  const outside = path.join(base, 'outside');
  const secret = path.join(outside, 'secret.txt');
  let service: InstanceType<typeof FilesystemService>;

  beforeEach(async () => {
    for (const dir of [path.join(appOne, 'data', 'nested'), appTwo, hubFolder, otherFolder, outside, path.join(base, 'install')]) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    await fs.promises.writeFile(secret, 'kept-private');
    await fs.promises.writeFile(path.join(hubFolder, 'private.txt'), 'hub-only');
    await fs.promises.writeFile(path.join(appTwo, 'other.txt'), 'other-app');
    service = new FilesystemService(mock<LoggerService>());
  });

  afterEach(async () => {
    await fs.promises.rm(data, { recursive: true, force: true });
    await fs.promises.rm(appData, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
    await fs.promises.rm(path.join(base, 'install'), { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.promises.rm(base, { recursive: true, force: true });
  });

  describe('reading', () => {
    it('reads through a link that stays in the same app folder', async () => {
      await fs.promises.writeFile(path.join(appOne, 'data', 'real.log'), 'log-line');
      await fs.promises.symlink('real.log', path.join(appOne, 'data', 'current.log'));
      await fs.promises.symlink(path.join(appOne, 'data', 'real.log'), path.join(appOne, 'data', 'absolute.log'));

      await expect(service.readTextFile(path.join(appOne, 'data', 'current.log'))).resolves.toBe('log-line');
      await expect(service.readTextFile(path.join(appOne, 'data', 'absolute.log'))).resolves.toBe('log-line');
    });

    it('refuses a link out of the allowed folders', async () => {
      await fs.promises.symlink(secret, path.join(appOne, 'data', 'link'));

      await expect(service.readTextFile(path.join(appOne, 'data', 'link'))).resolves.toBeNull();
      await expect(service.readBinaryFile(path.join(appOne, 'data', 'link'))).resolves.toBeNull();
      await expect(service.readJsonFile(path.join(appOne, 'data', 'link'))).resolves.toBeNull();
      await expect(service.pathExists(path.join(appOne, 'data', 'link'))).resolves.toBe(false);
      await expect(service.getStats(path.join(appOne, 'data', 'link'))).rejects.toThrow('File path is not allowed');
      await expect(service.getSafeFilePath(path.join(appOne, 'data', 'link'))).rejects.toThrow('File path is not allowed');
    });

    it('refuses a link from one allowed folder into another one', async () => {
      await fs.promises.symlink(path.join(hubFolder, 'private.txt'), path.join(appOne, 'data', 'link'));
      await fs.promises.symlink(path.join(hubFolder, 'private.txt'), path.join(otherFolder, 'link'));

      await expect(service.readTextFile(path.join(appOne, 'data', 'link'))).resolves.toBeNull();
      await expect(service.readTextFile(path.join(otherFolder, 'link'))).resolves.toBeNull();
    });

    it("refuses a link into another app's folder", async () => {
      await fs.promises.symlink(path.join(appTwo, 'other.txt'), path.join(appOne, 'data', 'link'));

      await expect(service.readTextFile(path.join(appOne, 'data', 'link'))).resolves.toBeNull();
    });

    it('refuses a real file reached through a link in the middle of the path', async () => {
      await fs.promises.symlink(outside, path.join(appOne, 'data', 'nested', 'dir'));

      await expect(service.readTextFile(path.join(appOne, 'data', 'nested', 'dir', 'secret.txt'))).resolves.toBeNull();
      await expect(service.listFiles(path.join(appOne, 'data', 'nested', 'dir'))).resolves.toEqual([]);
    });

    it('refuses a dangling link and a loop, without hanging', async () => {
      await fs.promises.symlink(path.join(outside, 'gone'), path.join(appOne, 'data', 'dangling'));
      await fs.promises.symlink('loop', path.join(appOne, 'data', 'loop'));

      await expect(service.readTextFile(path.join(appOne, 'data', 'dangling'))).resolves.toBeNull();
      await expect(service.pathExists(path.join(appOne, 'data', 'dangling'))).resolves.toBe(false);
      await expect(service.readTextFile(path.join(appOne, 'data', 'loop'))).resolves.toBeNull();
      await expect(service.pathExists(path.join(appOne, 'data', 'loop'))).resolves.toBe(false);
    });

    it('refuses a stream through a link out', async () => {
      await fs.promises.symlink(secret, path.join(appOne, 'data', 'link'));

      await expect(service.createReadStream(path.join(appOne, 'data', 'link'))).rejects.toThrow('File path is not allowed');
    });

    it('streams a byte range of a file that stays inside', async () => {
      await fs.promises.writeFile(path.join(appOne, 'data', 'video'), '0123456789');
      const stream = await service.createReadStream(path.join(appOne, 'data', 'video'), { start: 2, end: 4 });
      const chunks: Buffer[] = [];

      for await (const chunk of stream) chunks.push(chunk as Buffer);

      expect(Buffer.concat(chunks).toString()).toBe('234');
    });
  });

  describe('writing', () => {
    it('writes through a link that stays in the same folder', async () => {
      await fs.promises.writeFile(path.join(appOne, 'real.env'), 'old');
      await fs.promises.symlink('real.env', path.join(appOne, 'app.env'));

      await expect(service.writeTextFile(path.join(appOne, 'app.env'), 'new')).resolves.toBe(true);
      expect((await fs.promises.readFile(path.join(appOne, 'real.env'), 'utf8')).trim()).toBe('new');
      expect((await fs.promises.lstat(path.join(appOne, 'app.env'))).isSymbolicLink()).toBe(true);
    });

    it('refuses a write through a link out, leaving the target unchanged', async () => {
      await fs.promises.symlink(secret, path.join(appOne, 'data', 'link'));

      await expect(service.writeTextFile(path.join(appOne, 'data', 'link'), 'x')).resolves.toBe(false);
      await expect(service.writeJsonFile(path.join(appOne, 'data', 'link'), { x: 1 })).resolves.toBe(false);
      await expect(service.writeBinaryFile(path.join(appOne, 'data', 'link'), Buffer.from('x'))).resolves.toBe(false);
      await expect(service.restrictToOwner(path.join(appOne, 'data', 'link'))).resolves.toBe(false);
      await expect(fs.promises.readFile(secret, 'utf8')).resolves.toBe('kept-private');
    });

    it('does not create the target of a dangling link', async () => {
      const target = path.join(outside, 'created-by-write');
      await fs.promises.symlink(target, path.join(appOne, 'data', 'dangling'));

      await expect(service.writeTextFile(path.join(appOne, 'data', 'dangling'), 'x')).resolves.toBe(false);
      expect(fs.existsSync(target)).toBe(false);
    });

    it('refuses a new file below a folder link that leads out', async () => {
      await fs.promises.symlink(outside, path.join(appOne, 'data', 'dir'));

      await expect(service.writeTextFile(path.join(appOne, 'data', 'dir', 'new.txt'), 'x')).resolves.toBe(false);
      await expect(service.createDirectory(path.join(appOne, 'data', 'dir', 'sub'))).resolves.toBe(false);
      expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
      expect(fs.existsSync(path.join(outside, 'sub'))).toBe(false);
    });

    it('creates a new file and its parents inside a folder that does not exist yet', async () => {
      const file = path.join(appOne, 'new', 'deep', 'file.txt');

      await expect(service.writeTextFile(file, 'x')).resolves.toBe(true);
      expect((await fs.promises.readFile(file, 'utf8')).trim()).toBe('x');
    });

    it('refuses a copy onto or from a link that leads out', async () => {
      await fs.promises.writeFile(path.join(appOne, 'data', 'source'), 'content');
      await fs.promises.symlink(secret, path.join(appOne, 'data', 'link'));

      await expect(service.copyFile(path.join(appOne, 'data', 'source'), path.join(appOne, 'data', 'link'))).resolves.toBe(false);
      await expect(service.copyFile(path.join(appOne, 'data', 'link'), path.join(appOne, 'data', 'copy'))).resolves.toBe(false);
      await expect(fs.promises.readFile(secret, 'utf8')).resolves.toBe('kept-private');
    });

    it('treats a link at the path of a new exclusive file as something already there or refused', async () => {
      await fs.promises.symlink(secret, path.join(appOne, 'data', 'link'));
      await fs.promises.symlink(path.join(outside, 'gone'), path.join(appOne, 'data', 'dangling'));

      await expect(service.createFileIfMissing(path.join(appOne, 'data', 'link'), 'x', 0o600)).resolves.toBe('failed');
      await expect(service.createFileIfMissing(path.join(appOne, 'data', 'dangling'), 'x', 0o600)).resolves.toBe('failed');
      await expect(fs.promises.readFile(secret, 'utf8')).resolves.toBe('kept-private');
      expect(fs.existsSync(path.join(outside, 'gone'))).toBe(false);
    });
  });

  describe('operations on the link itself', () => {
    it('sees a link that leads out or nowhere and removes it without touching the target', async () => {
      await fs.promises.symlink(secret, path.join(appOne, 'data', 'out'));
      await fs.promises.symlink(path.join(outside, 'gone'), path.join(appOne, 'data', 'dangling'));

      expect((await service.getLinkStats(path.join(appOne, 'data', 'out'))).isSymbolicLink()).toBe(true);
      expect((await service.getLinkStats(path.join(appOne, 'data', 'dangling'))).isSymbolicLink()).toBe(true);
      await expect(service.isFile(path.join(appOne, 'data', 'out'))).resolves.toBe(false);
      await expect(service.isDirectory(path.join(appOne, 'data', 'out'))).resolves.toBe(false);
      await expect(service.removeFile(path.join(appOne, 'data', 'out'))).resolves.toBe(true);
      await expect(service.removeFile(path.join(appOne, 'data', 'dangling'))).resolves.toBe(true);
      expect(fs.existsSync(path.join(appOne, 'data', 'out'))).toBe(false);
      await expect(fs.promises.readFile(secret, 'utf8')).resolves.toBe('kept-private');
    });

    it('removes a folder holding a link that leads out, without following it', async () => {
      await fs.promises.symlink(outside, path.join(appOne, 'data', 'dir'));

      await expect(service.removeDirectory(appOne)).resolves.toBe(true);
      expect(fs.existsSync(appOne)).toBe(false);
      await expect(fs.promises.readFile(secret, 'utf8')).resolves.toBe('kept-private');
    });

    it('still refuses an entry reached through a link in its parent', async () => {
      await fs.promises.symlink(outside, path.join(appOne, 'data', 'dir'));

      await expect(service.removeFile(path.join(appOne, 'data', 'dir', 'secret.txt'))).resolves.toBe(false);
      await expect(fs.promises.readFile(secret, 'utf8')).resolves.toBe('kept-private');
    });
  });

  describe('legitimate setups', () => {
    it('follows links in the install folder, which only the Hub itself ships', async () => {
      await fs.promises.writeFile(path.join(outside, 'bundled.txt'), 'bundled');
      await fs.promises.symlink(path.join(outside, 'bundled.txt'), path.join(base, 'install', 'asset.txt'));

      await expect(service.readTextFile(path.join(base, 'install', 'asset.txt'))).resolves.toBe('bundled');
    });

    it('accepts a Hub folder that is itself a link to another disk', async () => {
      const elsewhere = path.join(outside, 'elsewhere');
      await fs.promises.mkdir(path.join(elsewhere, 'nested'), { recursive: true });
      await fs.promises.writeFile(path.join(elsewhere, 'nested', 'file'), 'on-other-disk');
      await fs.promises.rm(otherFolder, { recursive: true });
      await fs.promises.symlink(elsewhere, otherFolder);

      await expect(service.readTextFile(path.join(otherFolder, 'nested', 'file'))).resolves.toBe('on-other-disk');
      await expect(service.writeTextFile(path.join(otherFolder, 'nested', 'written'), 'x')).resolves.toBe(true);
      expect(fs.existsSync(path.join(elsewhere, 'nested', 'written'))).toBe(true);
    });

    it("accepts an app's folder that is a link to another disk", async () => {
      const elsewhere = path.join(outside, 'app-elsewhere');
      await fs.promises.mkdir(elsewhere, { recursive: true });
      await fs.promises.writeFile(path.join(elsewhere, 'file'), 'content');
      await fs.promises.rm(appTwo, { recursive: true });
      await fs.promises.symlink(elsewhere, appTwo);

      await expect(service.readTextFile(path.join(appTwo, 'file'))).resolves.toBe('content');
      await expect(service.isDirectory(appTwo)).resolves.toBe(false);
    });

    it('accepts a temp folder reached through a link, as on macOS', async () => {
      const realTemp = path.join(outside, 'real-temp');
      const linkedTemp = path.join(base, 'linked-temp');
      await fs.promises.mkdir(realTemp, { recursive: true });
      await fs.promises.symlink(realTemp, linkedTemp);
      const before = process.env.TMPDIR;
      process.env.TMPDIR = linkedTemp;

      try {
        const file = path.join(os.tmpdir(), 'staged');

        await expect(service.writeTextFile(file, 'staged')).resolves.toBe(true);
        expect(fs.existsSync(path.join(realTemp, 'staged'))).toBe(true);
        await expect(service.readTextFile(file)).resolves.toBe('staged\n');
      } finally {
        if (before === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = before;
        await fs.promises.rm(linkedTemp, { force: true });
      }
    });

    it('leaves kernel folders with their link layout untouched', async () => {
      await expect(service.getSafeFilePath('/sys/class/drm/card0/device/mem_info_vram_total')).resolves.toBe(
        '/sys/class/drm/card0/device/mem_info_vram_total',
      );
    });

    it('keeps refusing paths outside every allowed folder', async () => {
      await expect(service.getSafeFilePath('/not-an-allowed-folder/file')).rejects.toThrow('File path is not allowed');
      await expect(service.getSafeFilePath(path.join(appOne, path.relative(appOne, path.sep), 'not-allowed'))).rejects.toThrow(
        'File path is not allowed',
      );
    });

    it('accepts a path that does not exist yet', async () => {
      await expect(service.getSafeFilePath(path.join(appOne, 'not', 'yet', 'here'))).resolves.toBe(path.join(appOne, 'not', 'yet', 'here'));
    });

    it('gives a permission error the caller can act on, not a refusal', async () => {
      if (typeof process.getuid === 'function' && process.getuid() === 0) return;
      const locked = path.join(appOne, 'locked');
      await fs.promises.mkdir(path.join(locked, 'inner'), { recursive: true });
      await fs.promises.chmod(locked, 0o000);

      try {
        await expect(service.removeDirectoryDetailed(path.join(locked, 'inner'))).resolves.toEqual({ removed: false, permissionDenied: true });
      } finally {
        await fs.promises.chmod(locked, 0o700);
      }
    });
  });

  describe('backups and data browsing', () => {
    it('copies links as links, without reading through them', async () => {
      await fs.promises.writeFile(path.join(appOne, 'data', 'real.txt'), 'kept');
      await fs.promises.symlink('real.txt', path.join(appOne, 'data', 'in-link'));
      await fs.promises.symlink(secret, path.join(appOne, 'data', 'out-link'));
      await fs.promises.symlink(path.join(outside, 'gone'), path.join(appOne, 'data', 'dangling'));
      const dest = path.join(data, 'backups', 'copy');

      await expect(service.copyDirectory(path.join(appOne, 'data'), dest, { verbatimSymlinks: true })).resolves.toBe(true);

      await expect(fs.promises.readlink(path.join(dest, 'in-link'))).resolves.toBe('real.txt');
      await expect(fs.promises.readlink(path.join(dest, 'out-link'))).resolves.toBe(secret);
      await expect(fs.promises.readlink(path.join(dest, 'dangling'))).resolves.toBe(path.join(outside, 'gone'));
      await expect(fs.promises.readFile(path.join(dest, 'real.txt'), 'utf8')).resolves.toBe('kept');
    });

    it('reports a folder it cannot reach as unreadable and undeletable, not as clean', async () => {
      if (typeof process.getuid === 'function' && process.getuid() === 0) return;
      const locked = path.join(appOne, 'locked');
      const inner = path.join(locked, 'inner');
      await fs.promises.mkdir(inner, { recursive: true });
      await fs.promises.chmod(locked, 0o000);

      try {
        await expect(service.findUnreadable(inner)).resolves.toEqual([inner]);
        await expect(service.findUndeletable(inner)).resolves.toEqual([inner]);
      } finally {
        await fs.promises.chmod(locked, 0o700);
      }
    });

    it('answers nothing for a refused folder', async () => {
      await fs.promises.symlink(outside, path.join(appOne, 'data', 'dir'));

      await expect(service.findUnreadable(path.join(appOne, 'data', 'dir'))).resolves.toEqual([]);
      await expect(service.findUndeletable(path.join(appOne, 'data', 'dir'))).resolves.toEqual([]);
    });

    it('hands a copy filter the paths the caller named when a folder on the way is a link', async () => {
      const elsewhere = path.join(outside, 'moved-folder');
      await fs.promises.mkdir(path.join(elsewhere, 'app', 'keep'), { recursive: true });
      await fs.promises.mkdir(path.join(elsewhere, 'app', 'backups'), { recursive: true });
      await fs.promises.writeFile(path.join(elsewhere, 'app', 'keep', 'file'), 'kept');
      await fs.promises.writeFile(path.join(elsewhere, 'app', 'backups', 'old'), 'skipped');
      await fs.promises.rm(otherFolder, { recursive: true });
      await fs.promises.symlink(elsewhere, otherFolder);
      const source = path.join(otherFolder, 'app');
      const dest = path.join(data, 'backups', 'filtered');
      const seen: string[] = [];

      await expect(
        service.copyDirectory(source, dest, {
          filter: (src) => {
            seen.push(src);
            return !path.relative(source, src).includes('backups');
          },
        }),
      ).resolves.toBe(true);

      expect(seen.every((src) => src === source || src.startsWith(`${source}${path.sep}`))).toBe(true);
      expect(fs.existsSync(path.join(dest, 'keep', 'file'))).toBe(true);
      expect(fs.existsSync(path.join(dest, 'backups'))).toBe(false);
    });

    it('skips links when looking for unreadable data', async () => {
      await fs.promises.symlink(secret, path.join(appOne, 'data', 'out-link'));
      await fs.promises.symlink(path.join(outside, 'gone'), path.join(appOne, 'data', 'dangling'));

      await expect(service.findUnreadable(path.join(appOne, 'data'))).resolves.toEqual([]);
    });
  });
});
