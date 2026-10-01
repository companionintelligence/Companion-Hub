/**
 * A third-party app store is a git repo the Hub clones and then serves from, and the repo's author
 * controls every link in its tree. These tests build real trees, with real symlinks, and check that
 * nothing the Hub reads from them can lead out of the app's own folder.
 */
import os from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { AppStore } from '@/core/database/drizzle/types';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';

vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('@/core/filesystem/filesystem.service');
const { AppStoreFilesManager } = await import('../app-store-files-manager');

const STORE = 'test-store';
const APP = 'demo-app';
const URN = `${APP}:${STORE}` as AppUrn;

describe('AppStoreFilesManager and symbolic links', () => {
  let scratch: string;
  let dataDir: string;
  let appDataRoot: string;
  let secretFile: string;
  let secretDir: string;
  let repoApp: string;
  let installedApp: string;
  let manager: InstanceType<typeof AppStoreFilesManager>;

  const write = async (file: string, content = 'x') => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content);
  };

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'store-files-'));
    dataDir = path.join(scratch, 'data');
    appDataRoot = path.join(scratch, 'app-data');
    secretDir = path.join(scratch, 'secret');
    secretFile = path.join(secretDir, 'settings.json');
    repoApp = path.join(dataDir, 'repos', STORE, 'apps', APP);
    installedApp = path.join(dataDir, 'apps', STORE, APP);
    await write(secretFile, '{"hubLocalKey":"s3cret"}');
    await fs.promises.mkdir(repoApp, { recursive: true });

    const logger = mock<LoggerService>();
    const config = mock<ConfigurationService>();
    const directories = { dataDir, appDataDir: appDataRoot, appDir: scratch };
    config.getConfig.mockReturnValue({ directories } as never);
    config.get.mockImplementation(((key: string) => (key === 'directories' ? directories : undefined)) as never);

    manager = new AppStoreFilesManager(config, new FilesystemService(logger), logger, { slug: STORE } as AppStore);
  });

  afterEach(async () => {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  describe('media served to anyone who can reach the Hub', () => {
    it('serves a real logo', async () => {
      await write(path.join(repoApp, 'metadata', 'logo.png'), 'png');

      await expect(manager.findAppLogoPath(URN)).resolves.toBe(path.join(repoApp, 'metadata', 'logo.png'));
    });

    it('does not serve a logo that is a link to a file outside the app', async () => {
      await fs.promises.mkdir(path.join(repoApp, 'metadata'), { recursive: true });
      await fs.promises.symlink(secretFile, path.join(repoApp, 'metadata', 'logo.png'));

      await expect(manager.findAppLogoPath(URN)).resolves.toBeNull();
    });

    it('does not serve a logo reached through a metadata folder that links outside the app', async () => {
      await write(path.join(secretDir, 'logo.png'), 'not-yours');
      await fs.promises.symlink(secretDir, path.join(repoApp, 'metadata'));

      await expect(manager.findAppLogoPath(URN)).resolves.toBeNull();
    });

    it('does not serve a screenshot that is a link, nor list a screenshots folder that is one', async () => {
      await fs.promises.mkdir(path.join(repoApp, 'metadata'), { recursive: true });
      await fs.promises.symlink(secretDir, path.join(repoApp, 'metadata', 'screenshots'));

      await expect(manager.listLocalScreenshotFilenames(URN)).resolves.toEqual([]);
      await expect(manager.getScreenshot(URN, 'settings.json')).resolves.toMatchObject({ image: null });
    });

    it('serves a real screenshot', async () => {
      await write(path.join(repoApp, 'metadata', 'screenshots', 'one.png'), 'png-bytes');

      await expect(manager.listLocalScreenshotFilenames(URN)).resolves.toEqual(['one.png']);
      const shot = await manager.getScreenshot(URN, 'one.png');
      expect(shot.image?.toString()).toBe('png-bytes');
    });

    it('does not resolve a demo video that is a link out of the app', async () => {
      await fs.promises.mkdir(path.join(repoApp, 'metadata'), { recursive: true });
      await fs.promises.symlink(secretFile, path.join(repoApp, 'metadata', 'demo.mp4'));

      await expect(manager.findDemoVideoPath(URN, 'metadata/demo.mp4')).resolves.toBeNull();
      await expect(manager.getDemoVideoFile(URN, 'metadata/demo.mp4')).resolves.toBeNull();
    });

    it('resolves a real demo video', async () => {
      await write(path.join(repoApp, 'metadata', 'demo.mp4'), 'video');

      await expect(manager.findDemoVideoPath(URN, 'metadata/demo.mp4')).resolves.toBe(path.join(repoApp, 'metadata', 'demo.mp4'));
    });
  });

  describe('text the Hub parses and shows', () => {
    it('does not read a description.md that is a link to another file', async () => {
      await fs.promises.mkdir(path.join(repoApp, 'metadata'), { recursive: true });
      await fs.promises.symlink(secretFile, path.join(repoApp, 'metadata', 'description.md'));

      await expect(manager.readDescriptionMarkdown(URN)).resolves.toBeNull();
    });

    it('reads a real description.md', async () => {
      await write(path.join(repoApp, 'metadata', 'description.md'), '# Hello');

      await expect(manager.readDescriptionMarkdown(URN)).resolves.toBe('# Hello');
    });

    it('does not read a config.json that is a link', async () => {
      await fs.promises.symlink(secretFile, path.join(repoApp, 'config.json'));

      const result = await manager.getConfigJson(URN);

      expect(result.content).toBeNull();
    });

    it('does not read a docker-compose.json that is a link', async () => {
      await fs.promises.symlink(secretFile, path.join(repoApp, 'docker-compose.json'));

      const result = await manager.getDockerComposeJson(URN);

      expect(result.content).toBeNull();
    });
  });

  describe('copyDataDir', () => {
    const runCopy = () => manager.copyDataDir(URN, new Map());

    it('copies regular files and nested folders, and drops .gitkeep files at every level', async () => {
      await write(path.join(installedApp, 'data', 'conf', 'app.conf'), 'conf');
      await write(path.join(installedApp, 'data', '.gitkeep'), '');
      await write(path.join(installedApp, 'data', 'conf', 'deep', '.gitkeep'), '');
      await write(path.join(installedApp, 'data', 'conf', 'deep', 'keep.txt'), 'keep');

      await runCopy();

      const out = path.join(appDataRoot, STORE, APP, 'data');
      await expect(fs.promises.readFile(path.join(out, 'conf', 'app.conf'), 'utf8')).resolves.toBe('conf');
      await expect(fs.promises.readFile(path.join(out, 'conf', 'deep', 'keep.txt'), 'utf8')).resolves.toBe('keep');
      await expect(fs.promises.access(path.join(out, '.gitkeep'))).rejects.toThrow();
      await expect(fs.promises.access(path.join(out, 'conf', 'deep', '.gitkeep'))).rejects.toThrow();
    });

    it('does not copy a file that is a link to something outside the app', async () => {
      await fs.promises.mkdir(path.join(installedApp, 'data'), { recursive: true });
      await write(path.join(installedApp, 'data', 'real.txt'), 'real');
      await fs.promises.symlink(secretFile, path.join(installedApp, 'data', 'settings.json'));

      await runCopy();

      const out = path.join(appDataRoot, STORE, APP, 'data');
      await expect(fs.promises.readFile(path.join(out, 'real.txt'), 'utf8')).resolves.toBe('real');
      await expect(fs.promises.access(path.join(out, 'settings.json'))).rejects.toThrow();
    });

    it('does not descend into a folder that is a link', async () => {
      await fs.promises.mkdir(path.join(installedApp, 'data'), { recursive: true });
      await fs.promises.symlink(secretDir, path.join(installedApp, 'data', 'linked'));

      await runCopy();

      const out = path.join(appDataRoot, STORE, APP, 'data');
      await expect(fs.promises.access(path.join(out, 'linked', 'settings.json'))).rejects.toThrow();
    });

    it('treats a data folder that is itself a link as no data folder', async () => {
      await fs.promises.mkdir(installedApp, { recursive: true });
      await fs.promises.symlink(secretDir, path.join(installedApp, 'data'));

      await runCopy();

      await expect(fs.promises.access(path.join(appDataRoot, STORE, APP, 'data'))).rejects.toThrow();
    });

    it('runs no command for an app folder named like one', async () => {
      // `find ${appDataDir}/data ...` ran through /bin/sh with the folder name pasted in, so this name
      // executed `touch`. With no shell in the path it is only a name.
      const marker = path.join(scratch, 'pwned');
      const evilApp = `x$(touch ${marker})`;
      const evilUrn = `${evilApp}:${STORE}` as AppUrn;
      await write(path.join(dataDir, 'apps', STORE, evilApp, 'data', '.gitkeep'), '');

      await manager.copyDataDir(evilUrn, new Map());

      await expect(fs.promises.access(marker)).rejects.toThrow();
      await expect(fs.promises.access(path.join(appDataRoot, STORE, evilApp, 'data', '.gitkeep'))).rejects.toThrow();
    });
  });
});
