import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import { AppFilesManager } from '../app-files-manager';

describe('AppFilesManager: the record of the images an app pulled', () => {
  const appUrn = 'test-app:store' as AppUrn;
  // Beside the app folders, under the data folder: an update replaces the install folder, and the record must outlive it.
  const recordPath = path.resolve('/data', 'pulled-images', 'store', 'test-app.json');

  let filesystem: { readTextFile: ReturnType<typeof vi.fn>; writeTextFile: ReturnType<typeof vi.fn>; removeFile: ReturnType<typeof vi.fn> };
  let logger: { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let manager: AppFilesManager;

  beforeEach(() => {
    filesystem = {
      readTextFile: vi.fn(),
      writeTextFile: vi.fn().mockResolvedValue(true),
      removeFile: vi.fn().mockResolvedValue(true),
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

  it('forgets the record of the app', async () => {
    await manager.deletePulledImageIds(appUrn);

    expect(filesystem.removeFile).toHaveBeenCalledWith(recordPath);
  });
});
