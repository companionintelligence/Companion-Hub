import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { StartAppCommand } from '../start-app-command';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import type { AppUrn } from '@ci-hub/common/types';

vi.mock('node:fs', async () => ({
  default: {
    promises: {
      mkdir: vi.fn(),
      chmod: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn().mockResolvedValue(''),
    },
  },
}));

vi.mock('@ci-hub/common/schemas', async (importOriginal) => ({
  ...((await importOriginal()) as any),
  parseComposeJson: vi.fn().mockReturnValue({ services: [], overrides: [] }),
}));

describe('StartAppCommand — pull policy', () => {
  let command: StartAppCommand;
  let dockerService: any;
  let composeArgs: string[];
  let appFilesManager: any;
  const appUrn = 'urn:store:test-app' as AppUrn;

  beforeEach(() => {
    composeArgs = [];
    dockerService = {
      composeApp: vi.fn(async (_urn: string, args: string) => {
        composeArgs.push(args);
      }),
      removeAppNetworks: vi.fn().mockResolvedValue(undefined),
    };

    const logger = mockDeep<LoggerService>();
    const config = mock<ConfigurationService>();
    // @ts-expect-error
    config.get.mockImplementation((key: string) => {
      if (key === 'directories') return { dataDir: '/tmp', appDataDir: '/tmp/app-data' };
      if (key === 'architecture') return 'amd64';
      if (key === 'userSettings') return { domain: 'test.local', localDomain: 'local' };
      return {};
    });

    appFilesManager = mock<AppFilesManager>();
    appFilesManager.getInstalledAppInfo.mockResolvedValue({
      id: 'test-app',
      force_pull: false,
    } as any);
    appFilesManager.getDockerComposeJson.mockResolvedValue({ content: '{}', path: '/tmp' });
    appFilesManager.getAppEnv.mockResolvedValue({ content: '', path: '/tmp/.env' });
    appFilesManager.setAppDataDirPermissions.mockResolvedValue();
    appFilesManager.writeDockerComposeYml.mockResolvedValue();

    const appHelpers = mock<AppHelpers>();
    appHelpers.generateEnvFile.mockResolvedValue();

    const traefikConfigService = mock<TraefikConfigService>();
    traefikConfigService.regenerateTraefikConfig.mockResolvedValue();

    const marketplaceService = mock<MarketplaceService>();
    marketplaceService.copyAppFromRepoToInstalled.mockResolvedValue();

    const subnetManager = mock<SubnetManagerService>();
    subnetManager.allocateSubnet.mockResolvedValue('172.20.0.0/16');
    subnetManager.releaseSubnet.mockResolvedValue(undefined);
    subnetManager.listOccupiedSubnets.mockResolvedValue([
      { cidr: '10.128.10.0/24', source: 'docker', dockerNetworkName: 'chatwoot_ci-marketplace_network' },
    ]);

    const appsRepository = mock<AppsRepository>();
    appsRepository.getAppByUrn.mockResolvedValue({
      id: 1,
      subnet: '10.128.10.0/24',
    } as any);

    const dockerode = mock<Dockerode>();
    // @ts-expect-error
    dockerode.pruneContainers.mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 });

    const moduleRef = {
      get: vi.fn((token: any) => {
        if (token === LoggerService) return logger;
        if (token === ConfigurationService) return config;
        if (token === AppFilesManager) return appFilesManager;
        if (token === DockerService) return dockerService;
        if (token === AppHelpers) return appHelpers;
        if (token === TraefikConfigService) return traefikConfigService;
        if (token === MarketplaceService) return marketplaceService;
        if (token === SubnetManagerService) return subnetManager;
        if (token === AppsRepository) return appsRepository;
        if (token === EnvUtils) return new EnvUtils();
        return mock();
      }),
    } as unknown as ModuleRef;

    command = new StartAppCommand(moduleRef, dockerode);
  });

  it('MUST NOT include --pull never in compose args', async () => {
    await command.execute(appUrn, {});
    const upCmd = composeArgs.find((a) => a.includes('up'));
    expect(upCmd).not.toContain('--pull never');
  });

  it('MUST omit --pull flag when force_pull is false', async () => {
    await command.execute(appUrn, {});
    const upCmd = composeArgs.find((a) => a.includes('up'));
    expect(upCmd).not.toContain('--pull');
  });

  it('MUST include --pull always when force_pull is true', async () => {
    appFilesManager.getInstalledAppInfo.mockResolvedValue({
      id: 'test-app',
      force_pull: true,
    } as any);

    await command.execute(appUrn, {});
    const upCmd = composeArgs.find((a) => a.includes('up'));
    expect(upCmd).toContain('--pull always');
  });

  it('MUST omit --pull when skipPull is true even if force_pull is true', async () => {
    appFilesManager.getInstalledAppInfo.mockResolvedValue({
      id: 'test-app',
      force_pull: true,
    } as any);

    await command.execute(appUrn, { skipPull: true });
    const upCmd = composeArgs.find((a) => a.includes('up'));
    expect(upCmd).not.toContain('--pull');
  });

  it('SHOULD remove stale networks before compose up', async () => {
    await command.execute(appUrn, {});

    expect(dockerService.removeAppNetworks).toHaveBeenCalledWith(appUrn);
  });

  it('SHOULD retry compose up after a Docker network overlap error', async () => {
    dockerService.composeApp
      .mockRejectedValueOnce(new Error('failed to create network ghost_ci-marketplace_network: networks have overlapping IPv4'))
      .mockResolvedValueOnce(undefined);

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    expect(dockerService.removeAppNetworks).toHaveBeenCalledTimes(2);
    expect(dockerService.composeApp).toHaveBeenCalledTimes(2);
  });

  it('SHOULD return a friendly network overlap error after retries are exhausted', async () => {
    dockerService.composeApp.mockRejectedValue(
      new Error('failed to create network ghost_ci-marketplace_network: networks have overlapping IPv4 10.128.10.0/24'),
    );

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('network_overlap');
    expect(result.message).toContain('network range conflict');
    expect(result.errorDetail).toContain('10.128.10.0/24');
    expect(dockerService.composeApp).toHaveBeenCalledTimes(3);
  });
});
