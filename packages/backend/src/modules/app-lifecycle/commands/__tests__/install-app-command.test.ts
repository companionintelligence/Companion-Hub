import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { InstallAppCommand, extractComposeImages, mapPullProgressToInstallProgress, withMovedPort } from '../install-app-command';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { SSEService } from '@/core/sse/sse.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { AppLifecycleService } from '../../app-lifecycle.service';
import type { AppUrn } from '@ci-hub/common/types';
import { parseComposeJson } from '@ci-hub/common/schemas';
import { isRocmKfdPassthroughAvailable } from '@/modules/inference/host-rocm-availability';
import fs from 'node:fs';

// Mock fs
vi.mock('node:fs', async () => ({
  default: {
    constants: {
      F_OK: 0,
      R_OK: 4,
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

// The host-device preflight reads the installed compose with parseInstalledComposeJson: one stub
// stands for both parses.
vi.mock('@ci-hub/common/schemas', async (importOriginal) => {
  const parse = vi.fn().mockReturnValue({ services: [], overrides: [] });
  return { ...((await importOriginal()) as any), parseComposeJson: parse, parseInstalledComposeJson: parse };
});

vi.mock('@/modules/inference/host-rocm-availability', () => ({
  isRocmKfdPassthroughAvailable: vi.fn().mockResolvedValue(true),
}));

describe('install progress helpers', () => {
  it('extracts unique images from compose content', () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [
        { name: 'app', image: 'ghcr.io/example/app:latest' },
        { name: 'worker', image: 'ghcr.io/example/app:latest' },
        { name: 'db', image: 'postgres:16' },
      ],
      overrides: [],
    } as any);

    expect(extractComposeImages('services: {}')).toEqual(['ghcr.io/example/app:latest', 'postgres:16']);
  });

  it('maps pull byte progress into the reserved install range', () => {
    expect(mapPullProgressToInstallProgress(0, 100)).toBe(60);
    expect(mapPullProgressToInstallProgress(50, 100)).toBeGreaterThan(60);
    expect(mapPullProgressToInstallProgress(100, 100)).toBe(98);
  });
});

describe('withMovedPort', () => {
  it('moves the port a URL names, keeping the rest of it as written', () => {
    expect(withMovedPort('http://localhost:8080', 8080, 10000)).toBe('http://localhost:10000');
    expect(withMovedPort('http://localhost:8080/', 8080, 10000)).toBe('http://localhost:10000/');
    expect(withMovedPort('https://hub.tail1234.ts.net:8080/ghost?x=1#top', 8080, 10000)).toBe('https://hub.tail1234.ts.net:10000/ghost?x=1#top');
    expect(withMovedPort('http://[::1]:8080', 8080, 10000)).toBe('http://[::1]:10000');
    expect(withMovedPort('HTTP://192.168.1.20:8080', 8080, 10000)).toBe('HTTP://192.168.1.20:10000');
  });

  it('leaves a URL naming another port or none, and anything that is not an http(s) URL', () => {
    for (const value of [
      'http://localhost:18080',
      'http://localhost:80800',
      'http://localhost:808',
      'https://ghost.example.com',
      'https://ghost.example.com/blog:8080',
      'http://user:secret@localhost:8080',
      'localhost:8080',
      'ftp://localhost:8080',
      '',
    ]) {
      expect(withMovedPort(value, 8080, 10000)).toBe(value);
    }
  });
});

describe('InstallAppCommand — pull policy', () => {
  let command: InstallAppCommand;
  let dockerService: any;
  let dockerReadFacade: any;
  let composeArgs: string[] = [];
  let appFilesManager: ReturnType<typeof mock<AppFilesManager>>;

  const appUrn = 'urn:store:test-app' as AppUrn;

  beforeEach(() => {
    vi.mocked(parseComposeJson).mockReturnValue({ services: [], overrides: [] } as any);
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(true);
    vi.mocked(fs.promises.access).mockResolvedValue(undefined as any);

    composeArgs = [];
    dockerReadFacade = {
      diagnoseAppContainers: vi.fn().mockResolvedValue({ unhealthy: [], healthy: [] }),
    };
    dockerService = {
      composeApp: vi.fn(async (_urn: string, args: string) => {
        composeArgs.push(args);
      }),
      pullImages: vi.fn().mockResolvedValue(undefined),
      waitForManagedAppContainersReady: vi.fn().mockResolvedValue({
        ok: true,
        appStatus: 'running',
        summary: { total: 1, running: 1, exitZero: 0 },
        message: 'All containers are running',
      }),
      removeAppNetworks: vi.fn().mockResolvedValue(undefined),
      // Used by install-cancel compensation.
      snapshotAppImageIds: vi.fn().mockResolvedValue([]),
      removeAppImages: vi.fn().mockResolvedValue(undefined),
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

    appFilesManager = mock<AppFilesManager>();
    appFilesManager.getDockerComposeJson.mockResolvedValue({ content: '{}', path: '/tmp/compose.json' });
    appFilesManager.getAppEnv.mockResolvedValue({ content: '', path: '/tmp/.env' });
    appFilesManager.getUserComposeFile.mockResolvedValue({ content: null, path: '/tmp/user-compose.yml' });
    appFilesManager.setAppDataDirPermissions.mockResolvedValue();
    appFilesManager.writeDockerComposeYml.mockResolvedValue();
    appFilesManager.deleteAppFolder.mockResolvedValue(true);
    appFilesManager.deleteAppDataDir.mockResolvedValue(true);

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

    const appsRepository = mock<AppsRepository>();

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
        if (token === DockerReadFacade) return dockerReadFacade;
        if (token === AppHelpers) return appHelpers;
        if (token === SSEService) return sseService;
        if (token === EnvUtils) return envUtils;
        if (token === TraefikConfigService) return traefikConfigService;
        if (token === PortManagerService) return portManager;
        if (token === AppsRepository) return appsRepository;
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

  it('creates the bind-mount folders as the Hub, then opens them up, before compose up', async () => {
    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    expect(appFilesManager.createVolumeHostDirs).toHaveBeenCalledWith(appUrn);
    const created = appFilesManager.createVolumeHostDirs.mock.invocationCallOrder[0] as number;
    // The sweep that follows is what opens the new folders up for the app's own user.
    expect(appFilesManager.setAppDataDirPermissions.mock.invocationCallOrder.some((order) => order > created)).toBe(true);
  });

  it('MUST omit --pull flag entirely when force_pull is false', async () => {
    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    const upCommand = composeArgs.find((a) => a.includes('up'));
    expect(upCommand).toBeDefined();
    expect(upCommand).not.toContain('--pull');
  });

  it('MUST pre-pull images when force_pull is true and still omit --pull from compose up', async () => {
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
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'app', image: 'ghcr.io/example/app:latest' }],
      overrides: [],
    } as any);

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    expect(dockerService.pullImages).toHaveBeenCalled();
    const upCommand = composeArgs.find((a) => a.includes('up'));
    expect(upCommand).toBeDefined();
    expect(upCommand).not.toContain('--pull');
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
    expect(result.errorCode).toBe('rocm_kfd_missing');
    expect(result.message).toContain('Set up ROCm in AI Settings');
    expect(result.settingsPath).toBe('/settings?tab=ai&section=rocm');
  });

  // Reproduces production Sentry issue dfe2be44b8084d35b76c6d1d282c043d (comfyui, failure_phase
  // "start"): Docker checked /dev/dri first — listed before /dev/kfd in the app's
  // docker-compose.json — and failed on that device, so the raw error names /dev/dri.
  it('SHOULD return friendly guidance when Docker fails on /dev/dri (checked before /dev/kfd)', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest', devices: ['/dev/dri:/dev/dri', '/dev/kfd:/dev/kfd'] }],
      overrides: [],
    } as any);

    dockerService.composeApp = vi.fn(async (_urn: string, args: string) => {
      if (args.includes('up --detach')) {
        throw new Error(
          'Error response from daemon: error gathering device information while adding custom device "/dev/dri": no such file or directory',
        );
      }
    });

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('rocm_kfd_missing');
    expect(result.message).toContain('Set up ROCm in AI Settings');
    expect(result.settingsPath).toBe('/settings?tab=ai&section=rocm');
  });

  it('SHOULD allow install when host ROCm probe reports /dev/kfd even if container lacks /dev/kfd', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest', devices: ['/dev/kfd:/dev/kfd'] }],
      overrides: [],
    } as any);
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValueOnce(true);
    vi.mocked(fs.promises.access).mockRejectedValueOnce(new Error('ENOENT'));

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(true);
    expect(isRocmKfdPassthroughAvailable).toHaveBeenCalled();
    expect(composeArgs.some((a) => a.includes('up --detach'))).toBe(true);
  });

  it('SHOULD fail fast before compose up when /dev/kvm is required but missing', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'windows', image: 'docker.io/dockurr/windows:latest', devices: ['/dev/kvm:/dev/kvm'] }],
      overrides: [],
    } as any);
    vi.mocked(fs.promises.access).mockRejectedValueOnce(new Error('ENOENT'));

    const result = await command.execute('windows:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('kvm_missing');
    expect(result.message).toContain('hardware virtualization');
    expect(composeArgs.some((a) => a.includes('up --detach'))).toBe(false);
    expect(composeArgs.some((a) => a.includes('down'))).toBe(false);
  });

  it('SHOULD return friendly guidance when /dev/kvm is missing at compose up', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'windows', image: 'docker.io/dockurr/windows:latest', devices: ['/dev/kvm:/dev/kvm'] }],
      overrides: [],
    } as any);
    // Preflight thinks KVM exists; Docker then fails when attaching the device.
    vi.mocked(fs.promises.access).mockResolvedValueOnce(undefined as any);

    dockerService.composeApp = vi.fn(async (_urn: string, args: string) => {
      if (args.includes('up --detach')) {
        throw new Error(
          'Error response from daemon: error gathering device information while adding custom device "/dev/kvm": no such file or directory',
        );
      }
    });

    const result = await command.execute('windows:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('kvm_missing');
    expect(result.message).toContain('hardware virtualization');
  });

  it('SHOULD fail fast before compose up when /dev/kfd is required but missing', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest', devices: ['/dev/kfd:/dev/kfd'] }],
      overrides: [],
    } as any);
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValueOnce(false);

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('rocm_kfd_missing');
    expect(result.message).toContain('Set up ROCm in AI Settings');
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
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValueOnce(false);

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('rocm_kfd_missing');
    expect(result.message).toContain('Set up ROCm in AI Settings');
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
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValueOnce(false);

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('rocm_kfd_missing');
    expect(result.message).toContain('Set up ROCm in AI Settings');
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

  it('SHOULD fail install when labeled containers are missing after compose up', async () => {
    dockerService.waitForManagedAppContainersReady.mockResolvedValue({
      ok: false,
      appStatus: 'missing',
      summary: { total: 0, running: 0, exitZero: 0 },
      message: 'Install finished but no Hub-managed containers were found. The app may have failed to start.',
    });

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('no Hub-managed containers were found');
    expect(dockerService.waitForManagedAppContainersReady).toHaveBeenCalledWith(appUrn);
  });

  it('SHOULD fail install with container logs when containers exit after compose up', async () => {
    dockerService.waitForManagedAppContainersReady.mockResolvedValue({
      ok: false,
      appStatus: 'stopped',
      summary: { total: 1, running: 0, exitZero: 0 },
      message: 'One or more containers exited after install.',
      errorDetail: 'ghost-ghost-ci-marketplace (Exited (1)): bootstrap failed',
    });

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('exited after install');
    expect(result.errorDetail).toContain('bootstrap failed');
  });

  // ── cancellation ──────────────────────────────────────────────────────────
  it('aborting during the image pull cancels and runs compensation (no compose up)', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'app', image: 'ghcr.io/example/app:latest' }],
      overrides: [],
    } as any);

    const ac = new AbortController();
    // Simulate the real pullImages aborting once the signal fires.
    dockerService.pullImages = vi.fn(async () => {
      ac.abort();
      throw new DOMException('Aborted', 'AbortError');
    });

    const result = await command.execute(appUrn, {}, { signal: ac.signal, setPhase: vi.fn() });

    expect(result.success).toBe(false);
    expect((result as any).cancelled).toBe(true);
    // Compose up must never have run...
    expect(composeArgs.some((a) => a.includes('up --detach'))).toBe(false);
    // ...and compensation must have torn everything down (keeping pulled images via --rmi local).
    expect(composeArgs.some((a) => a.includes('down') && a.includes('--rmi local'))).toBe(true);
    expect(dockerService.removeAppNetworks).toHaveBeenCalledWith(appUrn);
    const afm = (command as any).moduleRef.get(AppFilesManager);
    expect(afm.deleteAppFolder).toHaveBeenCalledWith(appUrn);
    const pm = (command as any).moduleRef.get(PortManagerService);
    expect(pm.releaseAll).toHaveBeenCalledWith(appUrn);
  });

  it('aborting during compose up cancels and runs compensation', async () => {
    const ac = new AbortController();
    dockerService.composeApp = vi.fn(async (_urn: string, args: string) => {
      composeArgs.push(args);
      if (args.includes('up --detach')) {
        ac.abort();
        throw new DOMException('Aborted', 'AbortError');
      }
    });

    const result = await command.execute(appUrn, {}, { signal: ac.signal, setPhase: vi.fn() });

    expect(result.success).toBe(false);
    expect((result as any).cancelled).toBe(true);
    const afm = (command as any).moduleRef.get(AppFilesManager);
    expect(afm.deleteAppFolder).toHaveBeenCalledWith(appUrn);
  });

  it('returns cancelled (before compose up) when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await command.execute(appUrn, {}, { signal: ac.signal, setPhase: vi.fn() });

    expect(result.success).toBe(false);
    expect((result as any).cancelled).toBe(true);
    // The cooperative checkpoint aborts before compose up runs.
    expect(composeArgs.some((a) => a.includes('up --detach'))).toBe(false);
  });

  it('still succeeds when called without a cancellation context (backward compatible)', async () => {
    const result = await command.execute(appUrn, {});
    expect(result.success).toBe(true);
  });

  describe('when something outside the Hub holds the host port', () => {
    const envUtilsMap = (content: string) => Object.fromEntries(new EnvUtils().envStringToMap(content));
    /** Docker Engine 29.6's wording when a program on the host already listens on the port. */
    const portTaken = (port: number) =>
      new Error(
        `Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint test-app-1 (a65f29c5): failed to bind host port 127.0.0.1:${port}/tcp: address already in use`,
      );
    const mainAllocation = (hostPort: number) => ({
      id: hostPort,
      appUrn,
      hostPort,
      containerPort: 8080,
      protocol: 'tcp' as const,
      label: 'main',
      createdAt: '',
    });

    let portManager: ReturnType<typeof mock<PortManagerService>>;
    let appFilesManager: ReturnType<typeof mock<AppFilesManager>>;
    let appsRepository: ReturnType<typeof mock<AppsRepository>>;
    /** Host ports Docker refuses, in the order `compose up` meets them. */
    let refusals: number[];
    /** app.env as the last write left it, which the next read returns, as the file would. */
    let appEnv: string;

    beforeEach(() => {
      const moduleRef = (command as any).moduleRef as ModuleRef;
      portManager = moduleRef.get(PortManagerService) as any;
      appFilesManager = moduleRef.get(AppFilesManager) as any;
      appsRepository = moduleRef.get(AppsRepository) as any;

      // What generateEnvFile writes before the install allocates: the manifest's port, 8080.
      appEnv = ['APP_PORT=8080', 'APP_INTERNAL_AUTHORITY=127.0.0.1:8080', 'APP_URL=http://127.0.0.1:8080'].join('\n');
      appFilesManager.getAppEnv.mockImplementation(async () => ({ content: appEnv, path: '/tmp/.env' }));
      appFilesManager.writeAppEnv.mockImplementation(async (_urn, content) => {
        appEnv = content;
      });

      portManager.allocatePorts.mockResolvedValue([mainAllocation(8080)]);
      appsRepository.getAppByUrn.mockResolvedValue({ id: 7, port: 8080, config: { exposureMode: 'local' }, status: 'installing' } as any);

      refusals = [];
      dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
        composeArgs.push(args);
        const refused = args.startsWith('up') ? refusals.shift() : undefined;
        if (refused !== undefined) {
          throw portTaken(refused);
        }
      });
    });

    it('moves the main port to a free one, records it on the app and app.env, and installs', async () => {
      refusals = [8080];
      portManager.getMainPort.mockResolvedValue(8080);
      portManager.moveMainPort.mockResolvedValue(mainAllocation(10000));
      const form: { port?: number } = {};

      const result = await command.execute(appUrn, form);

      expect(result.success).toBe(true);
      expect(portManager.moveMainPort).toHaveBeenCalledExactlyOnceWith(appUrn, new Set([8080]));
      expect(composeArgs.filter((args) => args.startsWith('up'))).toHaveLength(2);
      const env = appFilesManager.writeAppEnv.mock.calls.at(-1)?.[1] ?? '';
      expect(env).toContain('APP_PORT=10000');
      expect(env).toContain('APP_INTERNAL_AUTHORITY=127.0.0.1:10000');
      expect(env).toContain('APP_URL=http://127.0.0.1:10000');
      // Starts, restarts and updates rebuild app.env from the row's config, so the port must be there.
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, { config: { exposureMode: 'local', port: 10000 }, port: 10000 });
      expect(form.port).toBe(10000);
    });

    it('never offers a port Docker already refused during the same install', async () => {
      refusals = [8080, 10000];
      portManager.getMainPort.mockResolvedValueOnce(8080).mockResolvedValueOnce(10000);
      const avoidedOnEachMove: number[][] = [];
      portManager.moveMainPort.mockImplementation(async (_urn, avoid) => {
        avoidedOnEachMove.push([...avoid]);
        return mainAllocation(avoidedOnEachMove.length === 1 ? 10000 : 10001);
      });

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(true);
      expect(avoidedOnEachMove).toEqual([[8080], [8080, 10000]]);
      expect(appFilesManager.writeAppEnv.mock.calls.at(-1)?.[1]).toContain('APP_PORT=10001');
    });

    it('fails as before when the refused port is not the main port', async () => {
      // An `addPorts` port from the manifest: it is published as written, so moving the main port would not help.
      refusals = [51820];
      portManager.getMainPort.mockResolvedValue(8080);

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(false);
      expect(portManager.moveMainPort).not.toHaveBeenCalled();
      expect(composeArgs.filter((args) => args.startsWith('up'))).toHaveLength(1);
    });

    it('leaves the app row alone when the main port is the one it already records', async () => {
      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(true);
      expect(appsRepository.updateAppById).not.toHaveBeenCalledWith(7, expect.objectContaining({ port: expect.anything() }));
    });

    it('records config.port when only the port column already holds the new port', async () => {
      // A retried install keeps the row's port from the failed attempt, but its config is the new form's.
      portManager.allocatePorts.mockResolvedValue([mainAllocation(10000)]);
      appsRepository.getAppByUrn.mockResolvedValue({ id: 7, port: 10000, config: { exposureMode: 'local' }, status: 'installing' } as any);

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(true);
      // Without config.port, the next start would go back to the manifest's port, 8080.
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, { config: { exposureMode: 'local', port: 10000 }, port: 10000 });
    });

    it('moves the base URLs that named the refused port, in app.env and in the stored config', async () => {
      refusals = [8080];
      portManager.getMainPort.mockResolvedValue(8080);
      portManager.moveMainPort.mockResolvedValue(mainAllocation(10000));
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        id: 'test-app',
        name: 'Test App',
        port: 8080,
        force_pull: false,
        form_fields: [
          { type: 'app_base_url', label: 'Site URL', env_variable: 'SITE_URL', alias_env_variables: ['SITE_URL_SLASH'], trailing_slash: true },
          { type: 'app_base_url', label: 'Media URL', env_variable: 'MEDIA_URL' },
          { type: 'url', label: 'Other service', env_variable: 'OTHER_URL' },
        ],
      } as any);
      appEnv = [
        'APP_PORT=8080',
        'APP_URL=http://127.0.0.1:8080',
        'APP_BASE_URL=http://127.0.0.1:8080',
        'APP_BASE_HOST=127.0.0.1:8080',
        'APP_BASE_WSS_ORIGIN=ws://127.0.0.1:8080',
        'SITE_URL=http://localhost:8080',
        'SITE_URL_SLASH=http://localhost:8080/',
        'MEDIA_URL=https://media.example.com',
        'OTHER_URL=http://localhost:8080',
      ].join('\n');
      const storedConfig = {
        exposureMode: 'local',
        SITE_URL: 'http://localhost:8080',
        MEDIA_URL: 'https://media.example.com',
        OTHER_URL: 'http://localhost:8080',
      };
      appsRepository.getAppByUrn.mockResolvedValue({ id: 7, port: 8080, config: storedConfig, status: 'installing' } as any);

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(true);
      const env = envUtilsMap(appEnv);
      expect(env).toMatchObject({
        APP_PORT: '10000',
        APP_URL: 'http://127.0.0.1:10000',
        APP_BASE_URL: 'http://127.0.0.1:10000',
        APP_BASE_HOST: '127.0.0.1:10000',
        APP_BASE_WSS_ORIGIN: 'ws://127.0.0.1:10000',
        SITE_URL: 'http://localhost:10000',
        SITE_URL_SLASH: 'http://localhost:10000/',
        // A public address names no port, and a `url` field is some other service's address.
        MEDIA_URL: 'https://media.example.com',
        OTHER_URL: 'http://localhost:8080',
      });
      // The stored form is what every later start replays.
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, {
        config: { ...storedConfig, SITE_URL: 'http://localhost:10000', port: 10000 },
        port: 10000,
      });
    });

    it('does not move the main port for a UDP mapping on the same number', async () => {
      portManager.getMainPort.mockResolvedValue(8080);
      dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
        composeArgs.push(args);
        if (args.startsWith('up')) {
          throw new Error('Error response from daemon: failed to bind host port 0.0.0.0:8080/udp: address already in use');
        }
      });

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(false);
      expect(portManager.moveMainPort).not.toHaveBeenCalled();
      expect(composeArgs.filter((args) => args.startsWith('up'))).toHaveLength(1);
    });
  });

  // ── download size in the progress ticks ─────────────────────────────────────
  describe('download progress ticks', () => {
    const MB = 1024 * 1024;
    const pullTick = (completedBytes: number, totalBytes: number) => ({
      activeImage: 'ghcr.io/example/app:latest',
      completedBytes,
      totalBytes,
      completedImages: 0,
      totalImages: 1,
      stage: 'downloading' as const,
    });
    /** The `status_change` ticks the page's progress bar reads, in order. */
    const progressTicks = () =>
      vi
        .mocked((command as any).moduleRef.get(SSEService).emit)
        .mock.calls.map(([, data]) => data as Record<string, unknown>)
        .filter((data) => data.event === 'status_change' && typeof data.progress === 'number');

    beforeEach(() => {
      vi.mocked(parseComposeJson).mockReturnValue({
        services: [{ name: 'app', image: 'ghcr.io/example/app:latest' }],
        overrides: [],
      } as any);
    });

    it('sends how much of the download has arrived with each tick', async () => {
      dockerService.pullImages = vi.fn(async (_images: string[], options: { onProgress: (event: unknown) => void }) => {
        options.onProgress(pullTick(50 * MB, 400 * MB));
      });

      await command.execute(appUrn, {});

      expect(progressTicks()).toContainEqual(expect.objectContaining({ progress: 64, downloadedBytes: 50 * MB, totalBytes: 400 * MB }));
    });

    it('sends a new tick when only the downloaded size moves', async () => {
      const now = vi.spyOn(Date, 'now');
      dockerService.pullImages = vi.fn(async (_images: string[], options: { onProgress: (event: unknown) => void }) => {
        now.mockReturnValue(1_000_000);
        options.onProgress(pullTick(50 * MB, 400 * MB));
        // One more MB, three seconds later: still 64%.
        now.mockReturnValue(1_003_000);
        options.onProgress(pullTick(51 * MB, 400 * MB));
      });

      try {
        await command.execute(appUrn, {});
      } finally {
        now.mockRestore();
      }

      const downloadTicks = progressTicks().filter((tick) => tick.progress === 64);
      expect(downloadTicks.map((tick) => tick.downloadedBytes)).toEqual([50 * MB, 51 * MB]);
    });

    /*
     * The pull's ticks are not awaited. When each one waited on the job write before it went out,
     * the last download tick could reach the page after "Finalizing", and stay there through
     * `compose up`.
     */
    it('sends each tick before the job write, so a slow write cannot reorder them', async () => {
      const writes: Array<() => void> = [];
      const updateProgress = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            writes.push(resolve);
          }),
      );
      dockerService.pullImages = vi.fn(async (_images: string[], options: { onProgress: (event: unknown) => void }) => {
        options.onProgress(pullTick(400 * MB, 400 * MB));
      });

      const install = command.execute(appUrn, {}, { signal: new AbortController().signal, setPhase: vi.fn(), updateProgress } as any);
      // Let the held writes go newest first, as a pool can finish them, until the install is done.
      const releaseWrites = setInterval(() => writes.pop()?.(), 0);
      try {
        await install;
      } finally {
        clearInterval(releaseWrites);
        for (const release of writes.splice(0)) release();
      }

      const percents = progressTicks().map((tick) => tick.progress);
      expect(percents).toContain(98);
      expect(percents.lastIndexOf(98)).toBeLessThan(percents.indexOf(99));
    });

    it('does not rewrite the job when only the downloaded size moved', async () => {
      const now = vi.spyOn(Date, 'now');
      const updateProgress = vi.fn().mockResolvedValue(undefined);
      dockerService.pullImages = vi.fn(async (_images: string[], options: { onProgress: (event: unknown) => void }) => {
        now.mockReturnValue(1_000_000);
        options.onProgress(pullTick(50 * MB, 400 * MB));
        now.mockReturnValue(1_003_000);
        options.onProgress(pullTick(51 * MB, 400 * MB));
      });

      try {
        await command.execute(appUrn, {}, { signal: new AbortController().signal, setPhase: vi.fn(), updateProgress } as any);
      } finally {
        now.mockRestore();
      }

      expect(updateProgress.mock.calls.filter(([percent]) => percent === 64)).toHaveLength(1);
    });
  });
});

describe('InstallAppCommand — plan-based pre-flight', () => {
  let command: InstallAppCommand;
  let dockerService: any;
  let appLifecycleService: { buildInstallPlan: ReturnType<typeof vi.fn> };
  const appUrn = 'urn:store:test-app' as AppUrn;

  const okPlan = {
    appUrn,
    checks: { config: { ok: true }, entitlement: { ok: true }, hostDevices: { ok: true }, architecture: { ok: true } },
    images: [],
    ports: [],
    formFields: [],
    blocked: false,
  };

  beforeEach(() => {
    vi.mocked(parseComposeJson).mockReturnValue({ services: [], overrides: [] } as any);
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(true);
    vi.mocked(fs.promises.access).mockResolvedValue(undefined as any);

    const dockerReadFacade = { diagnoseAppContainers: vi.fn().mockResolvedValue({ unhealthy: [], healthy: [] }) };
    dockerService = {
      composeApp: vi.fn().mockResolvedValue(undefined),
      pullImages: vi.fn().mockResolvedValue(undefined),
      waitForManagedAppContainersReady: vi.fn().mockResolvedValue({
        ok: true,
        appStatus: 'running',
        summary: { total: 1, running: 1, exitZero: 0 },
        message: 'All containers are running',
      }),
      removeAppNetworks: vi.fn().mockResolvedValue(undefined),
      snapshotAppImageIds: vi.fn().mockResolvedValue([]),
      removeAppImages: vi.fn().mockResolvedValue(undefined),
    };

    const logger = mockDeep<LoggerService>();
    const config = mock<ConfigurationService>();
    // @ts-expect-error
    config.get.mockImplementation((key: string) => {
      if (key === 'directories') return { dataDir: '/tmp', appDataDir: '/tmp/app-data' };
      if (key === 'architecture') return 'amd64';
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

    const marketplaceService = mock<MarketplaceService>();
    marketplaceService.getDockerComposeJson.mockResolvedValue({ content: '{}', path: '/tmp/compose.json' });
    marketplaceService.copyAppFromRepoToInstalled.mockResolvedValue();
    marketplaceService.copyDataDir.mockResolvedValue();

    const appHelpers = mock<AppHelpers>();
    appHelpers.generateEnvFile.mockResolvedValue();

    const sseService = mock<SSEService>();
    const envUtils = new EnvUtils();
    const portManager = mock<PortManagerService>();
    portManager.releaseAll.mockResolvedValue();
    portManager.allocatePorts.mockResolvedValue([]);

    appLifecycleService = { buildInstallPlan: vi.fn().mockResolvedValue(okPlan) };

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
        if (token === DockerReadFacade) return dockerReadFacade;
        if (token === AppHelpers) return appHelpers;
        if (token === SSEService) return sseService;
        if (token === EnvUtils) return envUtils;
        if (token === PortManagerService) return portManager;
        if (token === AppLifecycleService) return appLifecycleService;
        return mock();
      }),
    } as unknown as ModuleRef;

    command = new InstallAppCommand(moduleRef, dockerode);
  });

  it('proceeds normally when the plan reports no blocking checks', async () => {
    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    expect(appLifecycleService.buildInstallPlan).toHaveBeenCalledWith(appUrn, {});
    expect(dockerService.composeApp).toHaveBeenCalled();
  });

  it('aborts before touching the filesystem when the plan reports invalid config', async () => {
    appLifecycleService.buildInstallPlan.mockResolvedValue({
      ...okPlan,
      checks: { ...okPlan.checks, config: { ok: false, reason: 'Domain' } },
      blocked: true,
    });
    const marketplaceService = (command as any).moduleRef.get(MarketplaceService);

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect((result as any).errorCode).toBe('install_plan_blocked');
    expect((result as any).message).toContain('config (Domain)');
    expect(marketplaceService.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
  });

  it('aborts and reports both reasons when the plan blocks on config and architecture together', async () => {
    appLifecycleService.buildInstallPlan.mockResolvedValue({
      ...okPlan,
      checks: {
        ...okPlan.checks,
        config: { ok: false, reason: 'Domain' },
        architecture: { ok: false, reason: 'ghcr.io/ci/app:latest has no manifest for amd64 (available: arm64)' },
      },
      blocked: true,
    });

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect((result as any).message).toContain('config (Domain)');
    expect((result as any).message).toContain('architecture (ghcr.io/ci/app:latest has no manifest for amd64 (available: arm64))');
  });

  it('does not block on a plan-reported host-device failure — that check runs later, post-copy, with its own dedicated handling', async () => {
    appLifecycleService.buildInstallPlan.mockResolvedValue({
      ...okPlan,
      checks: { ...okPlan.checks, hostDevices: { ok: false, reason: 'stale plan snapshot' } },
      blocked: true,
    });

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
  });

  it('proceeds when the plan builder is unavailable (no AppLifecycleService wired, or it resolves no plan)', async () => {
    appLifecycleService.buildInstallPlan.mockResolvedValue(undefined as any);

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
  });

  it('proceeds when the plan builder rejects — a re-validation that cannot run is not evidence the install is invalid', async () => {
    appLifecycleService.buildInstallPlan.mockRejectedValue(new Error('marketplace lookup timed out'));

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    expect(dockerService.composeApp).toHaveBeenCalled();
  });

  it('proceeds when the plan builder is a bare mock that returns undefined instead of a promise (calling .catch on it must not crash the install)', async () => {
    // Regression case: an auto-mocked ModuleRef.get fallback (e.g. `mock()` with no
    // configured methods, as the sibling "pull policy" describe block's moduleRef.get
    // uses for any unlisted token) makes buildInstallPlan a bare vi.fn() that returns
    // `undefined` synchronously rather than a rejected promise. `.catch()` on that
    // `undefined` throws a TypeError before any promise machinery gets involved — a
    // real try/catch around the `await` is required, not a `.catch()` chained onto it.
    appLifecycleService.buildInstallPlan = vi.fn(() => undefined) as any;

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    expect(dockerService.composeApp).toHaveBeenCalled();
  });
});
