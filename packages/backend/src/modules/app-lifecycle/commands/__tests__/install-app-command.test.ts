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
import type { AppUrn } from '@ci-hub/common/types';
import { parseComposeJson } from '@ci-hub/common/schemas';
import fs from 'node:fs';

// Mock fs
vi.mock('node:fs', async () => ({
  default: {
    constants: {
      F_OK: 0,
    },
    promises: {
      mkdir: vi.fn(),
      chmod: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn().mockResolvedValue(''),
      access: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('@ci-hub/common/schemas', async (importOriginal) => ({
  ...((await importOriginal()) as any),
  parseComposeJson: vi.fn().mockReturnValue({ services: [], overrides: [] }),
}));

describe('InstallAppCommand — pull policy', () => {
  let command: InstallAppCommand;
  let dockerService: any;
  let composeArgs: string[] = [];

  const appUrn = 'urn:store:test-app' as AppUrn;

  beforeEach(() => {
    vi.mocked(parseComposeJson).mockReturnValue({ services: [], overrides: [] } as any);
    vi.mocked(fs.promises.access).mockResolvedValue(undefined as any);

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
    appFilesManager.getUserComposeFile.mockResolvedValue({ content: null, path: '/tmp/user-compose.yml' });
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

  it('keeps browser-facing env vars reachable after port allocation (no 0.0.0.0 reintroduced)', async () => {
    // Regression for the port-allocation rewrite: APP_HOSTNAME stays the raw listen IP
    // (0.0.0.0) for bind use, but APP_INTERNAL_AUTHORITY / APP_DOMAIN / APP_URL must be
    // rebuilt from the browser-reachable host. Otherwise allocation overwrites the
    // loopback host that generateEnvFile wrote and re-breaks CSRF on origin-strict apps.
    const moduleRef = (command as any).moduleRef;
    const config = moduleRef.get(ConfigurationService);
    const afm = moduleRef.get(AppFilesManager);
    const portManager = moduleRef.get(PortManagerService);
    // EnvUtils is wired as a real instance in this harness, so its (pure) serializers
    // run for real — the command rewrites the env map and we parse the captured write.
    const realEnv = new EnvUtils();

    // Appliance left at the shipped listen-all default.
    config.getConfig.mockReturnValue({
      internalIp: '0.0.0.0',
      directories: { dataDir: '/tmp', appDataDir: '/tmp/app-data' },
      domain: 'test.local',
      localDomain: 'local',
    });

    // Simulate what generateEnvFile already wrote: APP_HOSTNAME raw, browser-facing
    // vars normalized to loopback, internal (non-exposed) install.
    afm.getAppEnv.mockResolvedValue({
      path: '/tmp/.env',
      content: [
        'APP_HOSTNAME=0.0.0.0',
        'APP_EXPOSED=false',
        'APP_PORT=8080',
        'APP_INTERNAL_AUTHORITY=127.0.0.1:8080',
        'APP_DOMAIN=127.0.0.1:8080',
        'APP_HOST=127.0.0.1',
        'APP_URL=http://127.0.0.1:8080',
      ].join('\n'),
    });

    // Allocate the main port on a DIFFERENT host port than the seed (8090 vs 8080) so the
    // test also proves the derived URL/origin vars are re-synced to the allocated port,
    // not just left at their stale value.
    portManager.allocatePorts.mockResolvedValue([{ label: 'main', hostPort: 8090, containerPort: 8080, protocol: 'tcp' }]);

    const writes: string[] = [];
    afm.writeAppEnv.mockImplementation(async (_urn: string, content: string) => {
      writes.push(content);
    });

    await command.execute(appUrn, {});

    expect(portManager.allocatePorts).toHaveBeenCalled();
    expect(writes.length).toBeGreaterThan(0);
    // The first write is the port-allocation rewrite.
    const written = realEnv.envStringToMap(writes[0]);
    // Host normalized to loopback (not the raw 0.0.0.0) AND port synced to the allocation.
    expect(written.get('APP_INTERNAL_AUTHORITY')).toBe('127.0.0.1:8090');
    expect(written.get('APP_DOMAIN')).toBe('127.0.0.1:8090');
    expect(written.get('APP_URL')).toBe('http://127.0.0.1:8090');
    expect(written.get('APP_PORT')).toBe('8090');
    // The bind/listen address is intentionally left raw...
    expect(written.get('APP_HOSTNAME')).toBe('0.0.0.0');
    // ...but the unreachable listen-all addr must never leak into a browser-facing value.
    expect(writes[0]).not.toContain('APP_INTERNAL_AUTHORITY=0.0.0.0');
    expect(writes[0]).not.toContain('APP_DOMAIN=0.0.0.0');
    expect(writes[0]).not.toContain('APP_URL=http://0.0.0.0');
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

  it('SHOULD return friendly guidance when /dev/kfd is missing', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest', devices: ['/dev/kfd:/dev/kfd'] }],
      overrides: [],
    } as any);

    dockerService.composeApp = vi.fn(async (_urn: string, args: string) => {
      if (args.includes('up --detach')) {
        throw new Error(
          'Error response from daemon: error gathering device information while adding custom device "/dev/kfd": no such file or directory',
        );
      }
    });

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('requires an AMD GPU with ROCm drivers');
    expect(result.message).toContain('(/dev/kfd)');
  });

  it('SHOULD fail fast before compose up when /dev/kfd is required but missing', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest', devices: ['/dev/kfd:/dev/kfd'] }],
      overrides: [],
    } as any);
    vi.mocked(fs.promises.access).mockRejectedValueOnce(new Error('ENOENT'));

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('requires an AMD GPU with ROCm drivers');
    expect(result.message).toContain('(/dev/kfd)');
    expect(composeArgs.some((a) => a.includes('up --detach'))).toBe(false);
    // The destructive down must not run before the preflight either.
    expect(composeArgs.some((a) => a.includes('down'))).toBe(false);

    // Preflight must fire before port/env mutations — no allocations should have occurred.
    const portManager = (command as any).moduleRef.get(PortManagerService);
    expect(portManager.releaseAll).not.toHaveBeenCalled();
    expect(portManager.allocatePorts).not.toHaveBeenCalled();
  });

  it('SHOULD honor architecture overrides when checking /dev/kfd preflight', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest' }],
      overrides: [
        {
          architecture: 'amd64',
          services: [{ name: 'comfyui', devices: ['/dev/kfd:/dev/kfd'] }],
        },
      ],
    } as any);
    vi.mocked(fs.promises.access).mockRejectedValueOnce(new Error('ENOENT'));

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('requires an AMD GPU with ROCm drivers');
    expect(result.message).toContain('(/dev/kfd)');
    expect(composeArgs.some((a) => a.includes('up --detach'))).toBe(false);
    // The destructive down must not run before the preflight either.
    expect(composeArgs.some((a) => a.includes('down'))).toBe(false);

    // Preflight must fire before port/env mutations — no allocations should have occurred.
    const portManager = (command as any).moduleRef.get(PortManagerService);
    expect(portManager.releaseAll).not.toHaveBeenCalled();
    expect(portManager.allocatePorts).not.toHaveBeenCalled();
  });

  it('SHOULD fail fast when user compose override adds /dev/kfd and it is missing', async () => {
    // Base compose has no /dev/kfd requirement…
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest' }],
      overrides: [],
    } as any);
    // …but the user compose override introduces it.
    const afm = (command as any).moduleRef.get(AppFilesManager);
    afm.getUserComposeFile.mockResolvedValue({
      content: 'services:\n  comfyui:\n    devices:\n      - /dev/kfd:/dev/kfd\n      - /dev/dri:/dev/dri',
      path: '/tmp/user-compose.yml',
    });
    vi.mocked(fs.promises.access).mockRejectedValueOnce(new Error('ENOENT'));

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('requires an AMD GPU with ROCm drivers');
    expect(result.message).toContain('(/dev/kfd)');
    expect(composeArgs.some((a) => a.includes('up --detach'))).toBe(false);
    expect(composeArgs.some((a) => a.includes('down'))).toBe(false);
  });

  it('SHOULD skip /dev/kfd preflight when skipRun is true', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest', devices: ['/dev/kfd:/dev/kfd'] }],
      overrides: [],
    } as any);
    vi.mocked(fs.promises.access).mockRejectedValueOnce(new Error('ENOENT'));

    const result = await command.execute('comfyui:store' as AppUrn, { skipRun: true });

    expect(result.success).toBe(true);
    expect(result.message).toContain('installed successfully (skipped run)');
    expect(composeArgs.some((a) => a.includes('up --detach'))).toBe(false);
  });
});
