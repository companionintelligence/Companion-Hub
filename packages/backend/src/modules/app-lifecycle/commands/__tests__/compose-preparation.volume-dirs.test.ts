import os from 'node:os';
import path from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { ResourceAllocatorService } from '@/modules/system/resource-allocator.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';

// Real folders, so the test can see that the Hub made them, and as whom.
vi.unmock('node:fs');
vi.unmock('fs');

// The builder is tested on its own; here only the folders on disk matter.
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
const { prepareAppComposeDir } = await import('../compose-preparation');

/*
 * A custom app is added without an install, and install was the only step that made the folders its
 * volumes point at. Docker then made them on the first start, as root 755, so a service running as
 * any other user couldn't write to them and the Hub couldn't reset or delete what it wrote (#2198).
 */
describe.skipIf(process.platform === 'win32')('prepareAppComposeDir on a custom app', () => {
  const appUrn = 'notes:_user' as AppUrn;
  let scratch: string;
  let appDataRoot: string;
  let moduleRef: ModuleRef;
  let appFilesManager: InstanceType<typeof AppFilesManager>;

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compose-volume-dirs-'));
    const dataDir = path.join(scratch, 'data');
    appDataRoot = path.join(scratch, 'app-data');

    // What Add Custom App leaves: the definition folder and the data folder, nothing below it.
    const installed = path.join(dataDir, 'apps', '_user', 'notes');
    await fs.promises.mkdir(installed, { recursive: true });
    await fs.promises.mkdir(path.join(appDataRoot, '_user', 'notes'), { recursive: true });
    await fs.promises.writeFile(
      path.join(installed, 'docker-compose.json'),
      JSON.stringify({
        schemaVersion: 2,
        services: [
          {
            name: 'notes',
            image: 'python:3.13-alpine',
            isMain: true,
            internalPort: 8080,
            volumes: [
              { hostPath: '${APP_DATA_DIR}/data', containerPath: '/data' },
              { hostPath: '${APP_DATA_DIR}/app.env', containerPath: '/app/.env', readOnly: true },
            ],
          },
        ],
      }),
    );

    const logger = mock<LoggerService>();
    const configuration = mock<ConfigurationService>();
    const directories = { dataDir, appDataDir: appDataRoot };
    configuration.getConfig.mockReturnValue({ directories, domain: 'hub.example', localDomain: 'hub.lan', userSettings: {} } as never);
    configuration.get.mockImplementation(((key: string) => {
      if (key === 'architecture') return 'amd64';
      if (key === 'directories') return directories;
      return undefined;
    }) as never);

    appFilesManager = new AppFilesManager(configuration, new FilesystemService(logger), logger);
    const services = new Map<unknown, unknown>([
      [AppFilesManager, appFilesManager],
      [LoggerService, logger],
      [ConfigurationService, configuration],
      [
        MarketplaceService,
        {
          getAppInfoFromAppStoreOrInstalled: vi.fn().mockResolvedValue(null),
          copyAppFromRepoToInstalled: vi.fn(),
          listedAppUrns: vi.fn().mockResolvedValue([]),
        },
      ],
      [SubnetManagerService, { allocateSubnet: vi.fn().mockResolvedValue('10.128.7.0/24') }],
      [ResourceAllocatorService, { getEffectiveAppDefaults: vi.fn().mockResolvedValue({}) }],
      [AppsRepository, { getApps: vi.fn().mockResolvedValue([]), getAppCustomDomain: vi.fn().mockResolvedValue(null) }],
    ]);
    moduleRef = {
      get: (token: unknown) => {
        if (!services.has(token)) throw new Error(`Unexpected moduleRef.get token: ${String((token as { name?: string })?.name ?? token)}`);
        return services.get(token);
      },
    } as unknown as ModuleRef;
  });

  afterEach(async () => {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('makes the folder its volume points at, as the Hub, before compose up', async () => {
    const docker = { pruneContainers: vi.fn().mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 }) } as unknown as Dockerode;

    await prepareAppComposeDir(moduleRef, docker, appUrn, { openPort: true, exposureMode: 'local' } as unknown as AppEventFormInput);

    const stat = await fs.promises.stat(path.join(appDataRoot, '_user', 'notes', 'data'));
    expect(stat.isDirectory()).toBe(true);
    expect(stat.uid).toBe(process.getuid?.());
  });

  // Start prepares the folder, then writes app.env. A folder made at app.env first failed every Start.
  it('leaves app.env for the Hub to write when the app mounts it', async () => {
    const docker = { pruneContainers: vi.fn().mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 }) } as unknown as Dockerode;

    await prepareAppComposeDir(moduleRef, docker, appUrn, { openPort: true, exposureMode: 'local' } as unknown as AppEventFormInput);
    await appFilesManager.writeAppEnv(appUrn, 'APP_PORT=8080\n');

    const appEnv = path.join(appDataRoot, '_user', 'notes', 'app.env');
    expect((await fs.promises.lstat(appEnv)).isFile()).toBe(true);
    await expect(fs.promises.readFile(appEnv, 'utf8')).resolves.toContain('APP_PORT=8080');
  });
});
