import os from 'node:os';
import path from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppVolumeArchiveService } from '@/modules/docker/app-volume-archive.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { ResourceAllocatorService } from '@/modules/system/resource-allocator.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';

// Real files: the bug is what lands on disk, and in which order.
vi.unmock('node:fs');
vi.unmock('fs');

// The builder is tested on its own; here only the files on disk matter.
vi.mock('@/modules/docker/builders/compose.builder', () => ({
  DockerComposeBuilder: class {
    async getDockerCompose() {
      return 'services: {}\n';
    }
  },
}));

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('@/core/filesystem/filesystem.service');
const { AppFilesManager } = await import('@/modules/apps/app-files-manager');
const { AppStoreFilesManager } = await import('@/modules/app-stores/app-store-files-manager');
const { InstallAppCommand } = await import('../install-app-command');

/*
 * A store app that ships `data/config.yml` and mounts `${APP_DATA_DIR}/data/config.yml` (blocky,
 * caddy's Caddyfile, mosquitto's dynsec-setup.sh). Install prepares the compose folder before it
 * copies the store's data folder. If that early prepare made the volume folders, `data/config.yml`
 * became a directory, and copyDataDir, which skips an app whose `data/` exists, copied nothing:
 * not the file, not the templates rendered with the app's secrets (#2198).
 */
describe.skipIf(process.platform === 'win32')('InstallAppCommand on a store app that ships a data folder', () => {
  const appUrn = 'blocky:ci' as AppUrn;
  let scratch: string;
  let appDataDir: string;
  let moduleRef: ModuleRef;

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'install-store-data-dir-'));
    const dataDir = path.join(scratch, 'data');
    const appDataRoot = path.join(scratch, 'app-data');
    appDataDir = path.join(appDataRoot, 'ci', 'blocky');

    const compose = {
      schemaVersion: 2,
      services: [
        {
          name: 'blocky',
          image: 'spx01/blocky:v0.24',
          isMain: true,
          internalPort: 4000,
          volumes: [{ hostPath: '${APP_DATA_DIR}/data/config.yml', containerPath: '/app/config.yml', readOnly: true }],
        },
      ],
    };

    // What copyAppFromRepoToInstalled leaves: the store's definition, with its data folder.
    const installed = path.join(dataDir, 'apps', 'ci', 'blocky');
    await fs.promises.mkdir(path.join(installed, 'data'), { recursive: true });
    await fs.promises.writeFile(path.join(installed, 'docker-compose.json'), JSON.stringify(compose));
    await fs.promises.writeFile(path.join(installed, 'data', 'config.yml'), 'upstreams:\n  groups:\n    default: [1.1.1.1]\n');
    await fs.promises.writeFile(path.join(installed, 'data', 'secrets.env.template'), 'API_KEY={{BLOCKY_API_KEY}}\n');

    const logger = mock<LoggerService>();
    const configuration = mock<ConfigurationService>();
    const directories = { dataDir, appDataDir: appDataRoot };
    configuration.getConfig.mockReturnValue({ directories, domain: 'hub.example', localDomain: 'hub.lan', userSettings: {} } as never);
    configuration.get.mockImplementation(((key: string) => {
      if (key === 'architecture') return 'amd64';
      if (key === 'directories') return directories;
      return undefined;
    }) as never);

    const filesystem = new FilesystemService(logger);
    const appFilesManager = new AppFilesManager(configuration, filesystem, logger);
    // The real copy, as the store does it.
    const storeFiles = new AppStoreFilesManager(configuration, filesystem, logger, { slug: 'ci' } as never);

    const services = new Map<unknown, unknown>([
      [AppFilesManager, appFilesManager],
      [LoggerService, logger],
      [ConfigurationService, configuration],
      [EnvUtils, new EnvUtils()],
      [
        AppHelpers,
        {
          generateEnvFile: vi.fn(async () => {
            await fs.promises.mkdir(appDataDir, { recursive: true });
            await fs.promises.writeFile(path.join(appDataDir, 'app.env'), `APP_DATA_DIR=${appDataDir}\nBLOCKY_API_KEY=s3cret\n`);
          }),
        },
      ],
      [
        MarketplaceService,
        {
          getDockerComposeJson: vi.fn().mockResolvedValue({ content: compose }),
          copyAppFromRepoToInstalled: vi.fn(),
          copyDataDir: (urn: AppUrn, envMap: Map<string, string>) => storeFiles.copyDataDir(urn, envMap),
          getAppInfoFromAppStoreOrInstalled: vi.fn().mockResolvedValue(null),
          listedAppUrns: vi.fn().mockResolvedValue([]),
        },
      ],
      [AppVolumeArchiveService, { hasProjectVolumes: vi.fn().mockResolvedValue(false) }],
      [SubnetManagerService, { allocateSubnet: vi.fn().mockResolvedValue('10.128.7.0/24') }],
      [ResourceAllocatorService, { getEffectiveAppDefaults: vi.fn().mockResolvedValue({}) }],
      [
        AppsRepository,
        {
          getApps: vi.fn().mockResolvedValue([]),
          getAppCustomDomain: vi.fn().mockResolvedValue(null),
          getAppByUrn: vi.fn().mockResolvedValue(null),
        },
      ],
    ]);
    // Anything else install looks up (ports, SSE, entitlements, the plan recheck) is optional to it.
    moduleRef = { get: (token: unknown) => services.get(token) } as unknown as ModuleRef;
  });

  afterEach(async () => {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('copies the file a volume mounts, and does not make a folder in its place', async () => {
    const docker = { pruneContainers: vi.fn().mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 }) } as unknown as Dockerode;
    const command = new InstallAppCommand(moduleRef, docker);

    const result = await command.execute(appUrn, { openPort: true, exposureMode: 'local', skipRun: true } as unknown as AppEventFormInput);

    expect(result.success).toBe(true);
    const mounted = path.join(appDataDir, 'data', 'config.yml');
    const stat = await fs.promises.lstat(mounted);
    expect(stat.isDirectory()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(await fs.promises.readFile(mounted, 'utf8')).toContain('upstreams:');
    // The template is rendered with the app's secrets (the writer ends the file with its own newline).
    expect((await fs.promises.readFile(path.join(appDataDir, 'data', 'secrets.env'), 'utf8')).trim()).toBe('API_KEY=s3cret');
  });
});
