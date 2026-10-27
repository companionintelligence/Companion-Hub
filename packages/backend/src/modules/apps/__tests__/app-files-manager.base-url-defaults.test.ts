import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import { AppFilesManager } from '../app-files-manager';

/*
 * The env builder drops a base URL that is still the default the installed manifest gave a field that
 * writes APP_BASE_URL, a default getInstalledAppInfo reads the manifest without.
 */
describe('AppFilesManager.getInstalledBaseUrlDefaults', () => {
  const appUrn = 'envprobe:probe' as AppUrn;
  const manifest = {
    id: 'envprobe',
    name: 'Env probe',
    available: true,
    short_desc: 'A test app',
    author: 'Someone',
    source: 'https://example.com',
    port: 8080,
    form_fields: [
      { type: 'app_base_url', label: 'Public URL', env_variable: 'APP_BASE_URL', default: 'http://ci-hub.local' },
      { type: 'app_base_url', label: 'Docs URL', env_variable: 'DOCS_URL', default: 'https://docs.example' },
    ],
  };

  let filesystem: { pathExists: ReturnType<typeof vi.fn>; readTextFile: ReturnType<typeof vi.fn> };
  let manager: AppFilesManager;

  beforeEach(() => {
    filesystem = { pathExists: vi.fn().mockResolvedValue(true), readTextFile: vi.fn().mockResolvedValue(JSON.stringify(manifest)) };
    const configuration = {
      getConfig: () => ({ directories: { dataDir: '/data', appDataDir: '/app-data', appDir: '/app' } }),
    } as unknown as ConfigurationService;
    manager = new AppFilesManager(
      configuration,
      filesystem as unknown as FilesystemService,
      { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as LoggerService,
    );
  });

  it('names the default of each field that writes APP_BASE_URL', async () => {
    await expect(manager.getInstalledBaseUrlDefaults(appUrn)).resolves.toEqual(new Map([['APP_BASE_URL', 'http://ci-hub.local']]));
    expect(filesystem.readTextFile).toHaveBeenCalledWith(expect.stringMatching(/apps\/probe\/envprobe\/config\.json$/));
  });

  it('names none for a manifest it can’t find or read', async () => {
    filesystem.pathExists.mockResolvedValue(false);
    await expect(manager.getInstalledBaseUrlDefaults(appUrn)).resolves.toEqual(new Map());

    filesystem.pathExists.mockResolvedValue(true);
    filesystem.readTextFile.mockResolvedValue('{ not json');
    await expect(manager.getInstalledBaseUrlDefaults(appUrn)).resolves.toEqual(new Map());
  });
});
