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

vi.mock('@sentry/nestjs', () => ({
  captureException: vi.fn(),
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
});
