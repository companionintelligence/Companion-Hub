import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { InstallAppCommand } from '../install-app-command';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { SSEService } from '@/core/sse/sse.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import type { AppUrn } from '@runtipi/common/types';

// Mock fs
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

vi.mock('@runtipi/common/schemas', async (importOriginal) => ({
  ...((await importOriginal()) as any),
  parseComposeJson: vi.fn().mockReturnValue({ services: [], overrides: [] }),
}));

describe('InstallAppCommand — pull policy', () => {
  let command: InstallAppCommand;
  let dockerService: any;
  let composeArgs: string[] = [];

  const appUrn = 'urn:store:test-app' as AppUrn;

  beforeEach(() => {
    composeArgs = [];
    dockerService = {
      composeApp: vi.fn(async (_urn: string, args: string) => {
        composeArgs.push(args);
      }),
      diagnoseAppContainers: vi.fn().mockResolvedValue({ unhealthy: [], healthy: [] }),
    };

    const logger = mockDeep<LoggerService>();
    const config = mock<ConfigurationService>();
    // @ts-expect-error
    config.get.mockImplementation((key: string) => {
      if (key === 'directories') return { dataDir: '/tmp', appDataDir: '/tmp/app-data' };
      if (key === 'architecture') return 'amd64';
      if (key === 'userSettings') return { domain: 'test.local', localDomain: 'local' };
      if (key === 'domain') return 'test.local';
      if (key === 'localDomain') return 'local';
      return {};
    });
    // @ts-expect-error
    config.getConfig.mockReturnValue({
      internalIp: '127.0.0.1',
      directories: { dataDir: '/tmp', appDataDir: '/tmp/app-data' },
      domain: 'test.local',
      localDomain: 'local',
    });

    const appFilesManager = mock<AppFilesManager>();
    appFilesManager.getDockerComposeJson.mockResolvedValue({ content: '{}', path: '/tmp/compose.json' });
    appFilesManager.getAppEnv.mockResolvedValue({ content: '', path: '/tmp/.env' });
    appFilesManager.setAppDataDirPermissions.mockResolvedValue();
    appFilesManager.writeDockerComposeYml.mockResolvedValue();

    const marketplaceService = mock<MarketplaceService>();
    marketplaceService.getDockerComposeJson.mockResolvedValue({ content: '{}', path: '/tmp/compose.json' });
    marketplaceService.copyAppFromRepoToInstalled.mockResolvedValue();
    marketplaceService.copyDataDir.mockResolvedValue();

    const appHelpers = mock<AppHelpers>();
    appHelpers.generateEnvFile.mockResolvedValue();

    const sseService = mock<SSEService>();
    const envUtils = new EnvUtils();
    const traefikConfigService = mock<TraefikConfigService>();
    traefikConfigService.regenerateTraefikConfig.mockResolvedValue();

    const portManager = mock<PortManagerService>();
    portManager.releaseAll.mockResolvedValue();
    portManager.allocatePorts.mockResolvedValue([]);

    const cloudflareService = mock<CloudflareClientService>();

    const dockerode = mock<Dockerode>();
    // @ts-expect-error
    dockerode.pruneContainers.mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 });

    const moduleRef = {
      get: vi.fn((token: any) => {
        if (token === LoggerService) return logger;
        if (token === ConfigurationService) return config;
        if (token === AppFilesManager) return appFilesManager;
        if (token === MarketplaceService) return marketplaceService;
        if (token === DockerService) return dockerService;
        if (token === AppHelpers) return appHelpers;
        if (token === SSEService) return sseService;
        if (token === EnvUtils) return envUtils;
        if (token === TraefikConfigService) return traefikConfigService;
        if (token === PortManagerService) return portManager;
        if (token === CloudflareClientService) return cloudflareService;
        return mock();
      }),
    } as unknown as ModuleRef;

    // Create command with a callback to capture appInfo
    command = new InstallAppCommand(moduleRef, dockerode);

    // Mock getInstalledAppInfo on appFilesManager to control force_pull
    appFilesManager.getInstalledAppInfo.mockResolvedValue({
      id: 'test-app',
      name: 'Test App',
      port: 8080,
      categories: [],
      short_desc: 'test',
      author: 'test',
      source: 'test',
      available: true,
      force_pull: false,
    } as any);
  });

  it('MUST NOT include --pull never in compose args', async () => {
    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    const upCommand = composeArgs.find((a) => a.includes('up'));
    expect(upCommand).toBeDefined();
    expect(upCommand).not.toContain('--pull never');
  });

  it('MUST omit --pull flag entirely when force_pull is false', async () => {
    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    const upCommand = composeArgs.find((a) => a.includes('up'));
    expect(upCommand).toBeDefined();
    expect(upCommand).not.toContain('--pull');
  });

  it('MUST include --pull always when force_pull is true', async () => {
    // Get moduleRef to update appFilesManager mock
    const moduleRef = (command as any).moduleRef;
    const afm = moduleRef.get(AppFilesManager);
    afm.getInstalledAppInfo.mockResolvedValue({
      id: 'test-app',
      name: 'Test App',
      port: 8080,
      categories: [],
      short_desc: 'test',
      author: 'test',
      source: 'test',
      available: true,
      force_pull: true,
    } as any);

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    const upCommand = composeArgs.find((a) => a.includes('up'));
    expect(upCommand).toBeDefined();
    expect(upCommand).toContain('--pull always');
  });

  it('SHOULD pass through other compose arguments unchanged', async () => {
    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    const upCommand = composeArgs.find((a) => a.includes('up'));
    expect(upCommand).toContain('--detach');
    expect(upCommand).toContain('--force-recreate');
    expect(upCommand).toContain('--remove-orphans');
  });
});
