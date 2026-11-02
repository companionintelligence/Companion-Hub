import path from 'node:path';
import { vol } from 'memfs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import { AppFilesManager } from '../app-files-manager';

describe('AppFilesManager: the record of the images an app pulled', () => {
  const appUrn = 'test-app:store' as AppUrn;
  // Under state/, which a packaged Hub mounts: `/data` itself is root-owned and goes with the container.
  const recordPath = path.resolve('/data', 'state', 'pulled-images', 'store', 'test-app.json');
  const idA = `sha256:${'a'.repeat(64)}`;
  const idB = `sha256:${'b'.repeat(64)}`;

  let filesystem: {
    readTextFile: ReturnType<typeof vi.fn>;
    writeTextFile: ReturnType<typeof vi.fn>;
    removeFile: ReturnType<typeof vi.fn>;
    removeDirectory: ReturnType<typeof vi.fn>;
    pathExists: ReturnType<typeof vi.fn>;
  };
  let logger: { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let manager: AppFilesManager;

  beforeEach(() => {
    filesystem = {
      readTextFile: vi.fn(),
      writeTextFile: vi.fn().mockResolvedValue(true),
      removeFile: vi.fn().mockResolvedValue(true),
      removeDirectory: vi.fn().mockResolvedValue(true),
      pathExists: vi.fn().mockResolvedValue(true),
    };
    logger = { warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

    const configuration = {
      getConfig: () => ({
        directories: { dataDir: '/data', appDataDir: '/app-data', appDir: '/app' },
      }),
    } as unknown as ConfigurationService;

    manager = new AppFilesManager(configuration, filesystem as unknown as FilesystemService, logger as unknown as LoggerService);
  });

  it('reads the image IDs and tags the record holds for the app', async () => {
    filesystem.readTextFile.mockResolvedValue(JSON.stringify({ imageIds: [idA, idB], imageTags: ['app:1'] }));

    await expect(manager.readPulledImages(appUrn)).resolves.toEqual({ imageIds: [idA, idB], imageTags: ['app:1'] });
    expect(filesystem.readTextFile).toHaveBeenCalledWith(recordPath);
  });

  it('records no image when the app has no record, as an app that never pulled one', async () => {
    filesystem.readTextFile.mockResolvedValue(null);

    await expect(manager.readPulledImages(appUrn)).resolves.toEqual({ imageIds: [], imageTags: [] });
  });

  it('records no image, and says so, when the record is not valid JSON, so uninstall removes nothing it cannot account for', async () => {
    filesystem.readTextFile.mockResolvedValue('{"imageIds": [');

    await expect(manager.readPulledImages(appUrn)).resolves.toEqual({ imageIds: [], imageTags: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('keeps only the entries that are image IDs and says so', async () => {
    filesystem.readTextFile.mockResolvedValue(JSON.stringify({ imageIds: [idA, 7, '', null, { id: 'sha256:x' }], imageTags: ['app:1', 7] }));

    await expect(manager.readPulledImages(appUrn)).resolves.toEqual({ imageIds: [idA], imageTags: ['app:1'] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not image IDs'));
  });

  // Docker takes a name wherever it takes an ID, so an entry like this would remove whichever image has that name now.
  it.each(['postgres:16', 'sha256:short', '../containers/ci-hub', `sha256:${'A'.repeat(64)}`, `${idA}/json`])(
    'never takes %s for an image ID',
    async (entry) => {
      filesystem.readTextFile.mockResolvedValue(JSON.stringify({ imageIds: [entry] }));

      await expect(manager.readPulledImages(appUrn)).resolves.toEqual({ imageIds: [], imageTags: [] });
    },
  );

  it('holds no tags for a record written before it kept them, so uninstall keeps any image with a tag', async () => {
    filesystem.readTextFile.mockResolvedValue(JSON.stringify({ imageIds: [idA] }));

    await expect(manager.readPulledImages(appUrn)).resolves.toEqual({ imageIds: [idA], imageTags: [] });
  });

  it.each(['null', '[]', '7', '"text"', '{"imageIds":"sha256:a"}'])('records nothing for a record holding %s', async (text) => {
    filesystem.readTextFile.mockResolvedValue(text);

    await expect(manager.readPulledImages(appUrn)).resolves.toEqual({ imageIds: [], imageTags: [] });
  });

  it('writes the image IDs and tags to the record once each', async () => {
    await expect(manager.writePulledImages(appUrn, { imageIds: [idA, idB, idA], imageTags: ['app:1', 'app:1'] })).resolves.toBe(true);

    expect(filesystem.writeTextFile).toHaveBeenCalledWith(recordPath, JSON.stringify({ imageIds: [idA, idB], imageTags: ['app:1'] }, null, 2));
  });

  it('reports a record that could not be written', async () => {
    filesystem.writeTextFile.mockResolvedValue(false);

    await expect(manager.writePulledImages(appUrn, { imageIds: [idA], imageTags: [] })).resolves.toBe(false);
  });

  it('keeps the record in a folder the packaged compose file mounts, so it can be written and a Hub update keeps it', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const composeFile = realFs.readFileSync(path.resolve(__dirname, '../../../../../../docker-compose.prod.yml'), 'utf8');

    expect(composeFile).toContain('/state:/data/state\n');
  });

  it('forgets the record of the app', async () => {
    await manager.deletePulledImages(appUrn);

    expect(filesystem.removeFile).toHaveBeenCalledWith(recordPath);
  });

  it("forgets every app's record at once, for a factory reset", async () => {
    await manager.deleteAllPulledImages();

    expect(filesystem.removeDirectory).toHaveBeenCalledWith(path.resolve('/data', 'state', 'pulled-images'));
  });

  describe("with a real FilesystemService on the suite's disk", () => {
    const onDisk = () => {
      const configuration = { getConfig: () => ({ directories: { dataDir: '/data' } }) } as unknown as ConfigurationService;
      const diskLogger = { warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
      const service = new FilesystemService(diskLogger as unknown as LoggerService);
      return { logger: diskLogger, manager: new AppFilesManager(configuration, service, diskLogger as unknown as LoggerService) };
    };

    beforeEach(() => {
      vol.reset();
      vol.mkdirSync('/data/state', { recursive: true });
    });

    it('logs no error when the app has no record, which is the normal case', async () => {
      const disk = onDisk();

      await disk.manager.deletePulledImages(appUrn);

      expect(disk.logger.error).not.toHaveBeenCalled();
    });

    it('still logs a real failure to delete the record', async () => {
      const disk = onDisk();
      // A folder at the record's path: it exists and `unlink` refuses it.
      vol.mkdirSync(recordPath, { recursive: true });

      await disk.manager.deletePulledImages(appUrn);

      expect(disk.logger.error).toHaveBeenCalledWith(expect.stringContaining('Error removing file'), expect.anything());
    });

    it('writes, reads and forgets a record, creating the folders it needs', async () => {
      const disk = onDisk();

      await expect(disk.manager.writePulledImages(appUrn, { imageIds: [idA], imageTags: ['app:1'] })).resolves.toBe(true);
      await expect(disk.manager.readPulledImages(appUrn)).resolves.toEqual({ imageIds: [idA], imageTags: ['app:1'] });
      expect(vol.existsSync(recordPath)).toBe(true);

      await disk.manager.deletePulledImages(appUrn);

      expect(vol.existsSync(recordPath)).toBe(false);
      await expect(disk.manager.readPulledImages(appUrn)).resolves.toEqual({ imageIds: [], imageTags: [] });
    });

    it('forgets every record of every store and has nothing to complain about when there are none', async () => {
      const disk = onDisk();
      await disk.manager.deleteAllPulledImages();
      await disk.manager.writePulledImages(appUrn, { imageIds: [idA], imageTags: [] });
      await disk.manager.writePulledImages('other-app:_user' as AppUrn, { imageIds: [idB], imageTags: [] });

      await disk.manager.deleteAllPulledImages();

      expect(vol.existsSync(path.resolve('/data', 'state', 'pulled-images'))).toBe(false);
      expect(vol.existsSync('/data/state')).toBe(true);
      expect(disk.logger.error).not.toHaveBeenCalled();
    });
  });
});
