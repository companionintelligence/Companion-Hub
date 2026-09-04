import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import { AppFilesManager } from '../app-files-manager';

describe('AppFilesManager.listAppDataListing', () => {
  const appUrn = 'demo:community' as AppUrn;
  const appDataRoot = '/app-data/community/demo';

  let filesystem: {
    pathExists: ReturnType<typeof vi.fn>;
    listFiles: ReturnType<typeof vi.fn>;
    getStats: ReturnType<typeof vi.fn>;
  };
  let manager: AppFilesManager;

  beforeEach(() => {
    filesystem = {
      pathExists: vi.fn(),
      listFiles: vi.fn(),
      getStats: vi.fn(),
    };

    const configuration = {
      getConfig: () => ({
        directories: {
          dataDir: '/data',
          appDataDir: '/app-data',
          appDir: '/app',
        },
      }),
    } as unknown as ConfigurationService;

    manager = new AppFilesManager(
      configuration,
      filesystem as unknown as FilesystemService,
      { debug: vi.fn(), error: vi.fn() } as unknown as LoggerService,
    );
  });

  it('returns empty when the app data root is missing', async () => {
    filesystem.pathExists.mockResolvedValue(false);

    await expect(manager.listAppDataListing(appUrn)).resolves.toEqual({
      entries: [],
      truncated: false,
      rootExists: false,
    });
  });

  it('lists nested files with sizes and marks directories', async () => {
    filesystem.pathExists.mockResolvedValue(true);
    filesystem.listFiles.mockImplementation(async (dir: string) => {
      if (dir === appDataRoot) return ['config.json', 'data'];
      if (dir === path.join(appDataRoot, 'data')) return ['blob.bin'];
      return [];
    });
    filesystem.getStats.mockImplementation(async (filePath: string) => {
      if (filePath === path.join(appDataRoot, 'config.json')) {
        return { isDirectory: () => false, isFile: () => true, size: 12 };
      }
      if (filePath === path.join(appDataRoot, 'data')) {
        return { isDirectory: () => true, isFile: () => false, size: 0 };
      }
      if (filePath === path.join(appDataRoot, 'data', 'blob.bin')) {
        return { isDirectory: () => false, isFile: () => true, size: 2048 };
      }
      throw new Error(`unexpected path ${filePath}`);
    });

    await expect(manager.listAppDataListing(appUrn)).resolves.toEqual({
      entries: [
        { name: 'config.json', path: 'config.json', kind: 'file', sizeBytes: 12 },
        { name: 'data', path: 'data', kind: 'directory', sizeBytes: null },
        { name: 'blob.bin', path: 'data/blob.bin', kind: 'file', sizeBytes: 2048 },
      ],
      truncated: false,
      rootExists: true,
    });
  });
});
