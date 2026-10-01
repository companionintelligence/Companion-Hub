import os from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@/core/logger/logger.service';

// Real symlinks: the memfs mock the suite installs cannot tell a link from the file it points at.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('../filesystem.service');

describe('FilesystemService and symbolic links', () => {
  let scratch: string;
  let root: string;
  let outside: string;
  let service: InstanceType<typeof FilesystemService>;

  beforeEach(async () => {
    // Under os.tmpdir(), the one place `getSafeFilePath` allows besides the Hub's own folders.
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fs-links-'));
    root = path.join(scratch, 'repo', 'app');
    outside = path.join(scratch, 'secret');
    await fs.promises.mkdir(path.join(root, 'metadata'), { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'settings.json'), '{"hubLocalKey":"s3cret"}');
    await fs.promises.writeFile(path.join(root, 'metadata', 'logo.png'), 'png-bytes');
    service = new FilesystemService(mock<LoggerService>());
  });

  afterEach(async () => {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  describe('isFile / isDirectory', () => {
    it('are true for the real thing', async () => {
      await expect(service.isFile(path.join(root, 'metadata', 'logo.png'))).resolves.toBe(true);
      await expect(service.isDirectory(path.join(root, 'metadata'))).resolves.toBe(true);
    });

    it('are false for a symlink, whatever it points at', async () => {
      await fs.promises.symlink(path.join(outside, 'settings.json'), path.join(root, 'link-to-file'));
      await fs.promises.symlink(outside, path.join(root, 'link-to-dir'));

      await expect(service.isFile(path.join(root, 'link-to-file'))).resolves.toBe(false);
      await expect(service.isDirectory(path.join(root, 'link-to-dir'))).resolves.toBe(false);
    });

    it('are false, rather than thrown, for a path that is not there', async () => {
      await expect(service.isFile(path.join(root, 'nope'))).resolves.toBe(false);
      await expect(service.isDirectory(path.join(root, 'nope'))).resolves.toBe(false);
    });

    it('distinguish files from directories', async () => {
      await expect(service.isFile(path.join(root, 'metadata'))).resolves.toBe(false);
      await expect(service.isDirectory(path.join(root, 'metadata', 'logo.png'))).resolves.toBe(false);
    });
  });

  describe('isWithin', () => {
    it('accepts a regular file inside the root', async () => {
      await expect(service.isWithin(path.join(root, 'metadata', 'logo.png'), root)).resolves.toBe(true);
    });

    it('accepts a directory inside the root when asked for one', async () => {
      await expect(service.isWithin(path.join(root, 'metadata'), root, 'directory')).resolves.toBe(true);
      await expect(service.isWithin(path.join(root, 'metadata'), root, 'file')).resolves.toBe(false);
    });

    it('rejects a file that is itself a link out of the root', async () => {
      await fs.promises.symlink(path.join(outside, 'settings.json'), path.join(root, 'metadata', 'logo.jpg'));

      await expect(service.isWithin(path.join(root, 'metadata', 'logo.jpg'), root)).resolves.toBe(false);
    });

    // The case `pathExists` and `isFile` both pass: the file at the end is real, the link is in the middle.
    it('rejects a real file reached through a directory link out of the root', async () => {
      await fs.promises.rm(path.join(root, 'metadata'), { recursive: true });
      await fs.promises.symlink(outside, path.join(root, 'metadata'));

      const viaLink = path.join(root, 'metadata', 'settings.json');
      await expect(service.isFile(viaLink)).resolves.toBe(true); // what the old check saw
      await expect(service.isWithin(viaLink, root)).resolves.toBe(false);
    });

    it('rejects a directory link out of the root', async () => {
      await fs.promises.symlink(outside, path.join(root, 'screenshots'));

      await expect(service.isWithin(path.join(root, 'screenshots'), root, 'directory')).resolves.toBe(false);
    });

    it('accepts a link whose target stays inside the root', async () => {
      await fs.promises.symlink(path.join(root, 'metadata', 'logo.png'), path.join(root, 'alias.png'));

      await expect(service.isWithin(path.join(root, 'alias.png'), root)).resolves.toBe(true);
    });

    it('rejects the root itself', async () => {
      await expect(service.isWithin(root, root, 'directory')).resolves.toBe(false);
    });

    it('rejects a sibling that merely shares the root as a name prefix', async () => {
      const sibling = `${root}-evil`;
      await fs.promises.mkdir(sibling, { recursive: true });
      await fs.promises.writeFile(path.join(sibling, 'x.png'), 'x');

      await expect(service.isWithin(path.join(sibling, 'x.png'), root)).resolves.toBe(false);
    });

    it('rejects a path that does not exist, and a dangling link', async () => {
      await fs.promises.symlink(path.join(scratch, 'gone'), path.join(root, 'dangling'));

      await expect(service.isWithin(path.join(root, 'nope.png'), root)).resolves.toBe(false);
      await expect(service.isWithin(path.join(root, 'dangling'), root)).resolves.toBe(false);
    });

    it('rejects a ../ spelling that climbs out', async () => {
      await expect(service.isWithin(path.join(root, '..', '..', 'secret', 'settings.json'), root)).resolves.toBe(false);
    });

    it('still works when the root is reached through a symlinked parent', async () => {
      const alias = path.join(scratch, 'alias-root');
      await fs.promises.symlink(root, alias);

      await expect(service.isWithin(path.join(alias, 'metadata', 'logo.png'), alias)).resolves.toBe(true);
    });
  });
});
