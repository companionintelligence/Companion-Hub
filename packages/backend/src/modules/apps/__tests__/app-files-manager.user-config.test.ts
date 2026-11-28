import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';

// The real filesystem: what matters is which folders an uninstall leaves on disk.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('@/core/filesystem/filesystem.service');
const { AppFilesManager } = await import('../app-files-manager');

// root ignores permission bits, so the refused delete can't be made.
const canEnforcePermissions = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

describe("AppFilesManager: an app's user config folder", () => {
  const appUrn = 'notes:_user' as AppUrn;
  let scratch: string;
  let userConfigRoot: string;
  let rootFolderHost: string;
  let manager: InstanceType<typeof AppFilesManager>;

  const write = async (relative: string, content = 'x') => {
    const file = path.join(userConfigRoot, relative);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content);
  };
  const exists = (relative: string) => fs.existsSync(path.join(userConfigRoot, relative));

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'user-config-'));
    userConfigRoot = path.join(scratch, 'user-config');
    rootFolderHost = '/host/root';
    const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as LoggerService;
    const configuration = {
      getConfig: () => ({ directories: { dataDir: scratch, appDataDir: path.join(scratch, 'app-data'), appDir: scratch }, rootFolderHost }),
    } as unknown as ConfigurationService;
    manager = new AppFilesManager(configuration, new FilesystemService(logger), logger);
  });

  afterEach(async () => {
    await fs.promises.chmod(path.join(userConfigRoot, '_user', 'notes', 'locked'), 0o755).catch(() => null);
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('is the folder the user config files are read from', async () => {
    await write('_user/notes/docker-compose.yml', 'services: {}\n');
    await write('_user/notes/app.env', 'GREETING=hello\n');

    expect(manager.getUserConfigDir(appUrn)).toBe(path.join(userConfigRoot, '_user', 'notes'));
    await expect(manager.getUserComposeFile(appUrn)).resolves.toEqual({
      path: path.join(userConfigRoot, '_user', 'notes', 'docker-compose.yml'),
      content: 'services: {}\n',
    });
    await expect(manager.getUserEnv(appUrn)).resolves.toEqual({
      path: path.join(userConfigRoot, '_user', 'notes', 'app.env'),
      content: 'GREETING=hello\n',
    });
  });

  it("removes only that app's folder, not the Hub's own override or another app's", async () => {
    await write('_user/notes/docker-compose.yml');
    await write('_user/notes/app.env');
    await write('_user/notes-old/app.env');
    await write('community/notes/app.env');
    await write('hub-compose.yml');

    await expect(manager.deleteUserConfigDirDetailed(appUrn)).resolves.toEqual({ removed: true, permissionDenied: false });

    expect(exists('_user/notes')).toBe(false);
    expect(exists('_user/notes-old/app.env')).toBe(true);
    expect(exists('community/notes/app.env')).toBe(true);
    expect(exists('hub-compose.yml')).toBe(true);
    await expect(manager.getUserComposeFile(appUrn)).resolves.toMatchObject({ content: null });
    await expect(manager.getUserEnv(appUrn)).resolves.toMatchObject({ content: null });
  });

  it('counts a folder that is not there as removed', async () => {
    await expect(manager.deleteUserConfigDirDetailed(appUrn)).resolves.toEqual({ removed: true, permissionDenied: false });
    await expect(manager.deleteUserConfigDir(appUrn)).resolves.toBe(true);
  });

  it.skipIf(!canEnforcePermissions)('says a delete the Hub may not do was refused for permissions, so root can be asked', async () => {
    await write('_user/notes/locked/app.env');
    await fs.promises.chmod(path.join(userConfigRoot, '_user', 'notes', 'locked'), 0o500);

    await expect(manager.deleteUserConfigDirDetailed(appUrn)).resolves.toEqual({ removed: false, permissionDenied: true });
  });

  describe('is a real folder, for the root helper', () => {
    const outside = () => path.join(scratch, 'outside');

    beforeEach(async () => {
      await fs.promises.mkdir(outside(), { recursive: true });
      await fs.promises.writeFile(path.join(outside(), 'keep.txt'), 'x');
    });

    it('when it and its store folder are folders', async () => {
      await write('_user/notes/app.env');

      await expect(manager.isUserConfigDirPlainFolder(appUrn)).resolves.toBe(true);
    });

    it('not when the app folder is a link to somewhere else', async () => {
      await fs.promises.mkdir(path.join(userConfigRoot, '_user'), { recursive: true });
      await fs.promises.symlink(outside(), path.join(userConfigRoot, '_user', 'notes'));

      await expect(manager.isUserConfigDirPlainFolder(appUrn)).resolves.toBe(false);
    });

    it('not when the store folder is a link', async () => {
      await fs.promises.mkdir(path.join(outside(), 'notes'), { recursive: true });
      await fs.promises.mkdir(userConfigRoot, { recursive: true });
      await fs.promises.symlink(outside(), path.join(userConfigRoot, '_user'));

      await expect(manager.isUserConfigDirPlainFolder(appUrn)).resolves.toBe(false);
    });

    it('not when it is missing or a file', async () => {
      await expect(manager.isUserConfigDirPlainFolder(appUrn)).resolves.toBe(false);

      await write('_user/notes', 'not a folder');
      await expect(manager.isUserConfigDirPlainFolder(appUrn)).resolves.toBe(false);
    });

    it("and the Hub's own delete removes a link without touching what it points to", async () => {
      await fs.promises.mkdir(path.join(userConfigRoot, '_user'), { recursive: true });
      await fs.promises.symlink(outside(), path.join(userConfigRoot, '_user', 'notes'));

      await expect(manager.deleteUserConfigDirDetailed(appUrn)).resolves.toEqual({ removed: true, permissionDenied: false });
      expect(exists('_user/notes')).toBe(false);
      expect(fs.existsSync(path.join(outside(), 'keep.txt'))).toBe(true);
    });
  });

  it("is under the Hub's root folder on the host for a manual rm", () => {
    expect(manager.getUserConfigHostDir(appUrn)).toBe('/host/root/user-config/_user/notes');

    rootFolderHost = 'C:\\hub';
    expect(manager.getUserConfigHostDir(appUrn)).toBe('C:\\hub\\user-config\\_user\\notes');
  });

  it('has no host path when the root folder on the host is not an absolute path', () => {
    rootFolderHost = '.internal';
    expect(manager.getUserConfigHostDir(appUrn)).toBeUndefined();

    rootFolderHost = '';
    expect(manager.getUserConfigHostDir(appUrn)).toBeUndefined();
  });
});
