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

  it('reads the image IDs the record holds for the app', async () => {
    filesystem.readTextFile.mockResolvedValue(JSON.stringify({ imageIds: ['sha256:a', 'sha256:b'] }));

    await expect(manager.readPulledImageIds(appUrn)).resolves.toEqual(['sha256:a', 'sha256:b']);
    expect(filesystem.readTextFile).toHaveBeenCalledWith(recordPath);
  });

  it('records no image when the app has no record, as an app that never pulled one', async () => {
    filesystem.readTextFile.mockResolvedValue(null);

    await expect(manager.readPulledImageIds(appUrn)).resolves.toEqual([]);
  });

  it('records no image, and says so, when the record is not valid JSON, so uninstall removes nothing it cannot account for', async () => {
    filesystem.readTextFile.mockResolvedValue('{"imageIds": [');

    await expect(manager.readPulledImageIds(appUrn)).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('keeps only the entries that are image IDs', async () => {
    filesystem.readTextFile.mockResolvedValue(JSON.stringify({ imageIds: ['sha256:a', 7, '', null, { id: 'sha256:x' }] }));

    await expect(manager.readPulledImageIds(appUrn)).resolves.toEqual(['sha256:a']);
  });

  it('writes the image IDs to the record once each', async () => {
    await expect(manager.writePulledImageIds(appUrn, ['sha256:a', 'sha256:b', 'sha256:a'])).resolves.toBe(true);

    expect(filesystem.writeTextFile).toHaveBeenCalledWith(recordPath, JSON.stringify({ imageIds: ['sha256:a', 'sha256:b'] }, null, 2));
  });

  it('reports a record that could not be written', async () => {
    filesystem.writeTextFile.mockResolvedValue(false);

    await expect(manager.writePulledImageIds(appUrn, ['sha256:a'])).resolves.toBe(false);
  });

  it('keeps the record in a folder the packaged compose file mounts, so it can be written and a Hub update keeps it', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const composeFile = realFs.readFileSync(path.resolve(__dirname, '../../../../../../docker-compose.prod.yml'), 'utf8');

    expect(composeFile).toContain('/state:/data/state\n');
  });

  it('forgets the record of the app', async () => {
    await manager.deletePulledImageIds(appUrn);

    expect(filesystem.removeFile).toHaveBeenCalledWith(recordPath);
  });

  it("forgets every app's record at once, for a factory reset", async () => {
    await manager.deleteAllPulledImageIds();

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

      await disk.manager.deletePulledImageIds(appUrn);

      expect(disk.logger.error).not.toHaveBeenCalled();
    });

    it('still logs a real failure to delete the record', async () => {
      const disk = onDisk();
      // A folder at the record's path: it exists and `unlink` refuses it.
      vol.mkdirSync(recordPath, { recursive: true });

      await disk.manager.deletePulledImageIds(appUrn);

      expect(disk.logger.error).toHaveBeenCalledWith(expect.stringContaining('Error removing file'), expect.anything());
    });

    it('writes, reads and forgets a record, creating the folders it needs', async () => {
      const disk = onDisk();

      await expect(disk.manager.writePulledImageIds(appUrn, ['sha256:a'])).resolves.toBe(true);
      await expect(disk.manager.readPulledImageIds(appUrn)).resolves.toEqual(['sha256:a']);
      expect(vol.existsSync(recordPath)).toBe(true);

      await disk.manager.deletePulledImageIds(appUrn);

      expect(vol.existsSync(recordPath)).toBe(false);
      await expect(disk.manager.readPulledImageIds(appUrn)).resolves.toEqual([]);
    });

    it('forgets every record of every store and has nothing to complain about when there are none', async () => {
      const disk = onDisk();
      await disk.manager.deleteAllPulledImageIds();
      await disk.manager.writePulledImageIds(appUrn, ['sha256:a']);
      await disk.manager.writePulledImageIds('other-app:_user' as AppUrn, ['sha256:b']);

      await disk.manager.deleteAllPulledImageIds();

      expect(vol.existsSync(path.resolve('/data', 'state', 'pulled-images'))).toBe(false);
      expect(vol.existsSync('/data/state')).toBe(true);
      expect(disk.logger.error).not.toHaveBeenCalled();
    });
  });
});
