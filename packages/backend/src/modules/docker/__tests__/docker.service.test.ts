import { Test, TestingModule } from '@nestjs/testing';
import { DockerService } from '../docker.service';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppsService } from '../../apps/apps.service';
import { DOCKERODE } from '../constants';
import { mock, MockProxy } from 'vitest-mock-extended';
import * as child_process from 'node:child_process';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type Dockerode from 'dockerode';

// The Hub compose args are built with path.join (platform-aware: `\` on Windows), so
// derive the expected paths the same way to keep these assertions correct on Windows.
const HUB_ENV_FILE = path.join('/data', '.env');
const HUB_COMPOSE_FILE = path.join('/data', 'docker-compose.yml');

const createMockSpawnProcess = () => {
  const process = new EventEmitter() as any;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = vi.fn();
  return process;
};

const createComposeProbeProcess = (exitCode: number) => {
  const process = createMockSpawnProcess();
  process.on = vi.fn().mockImplementation((event, handler) => {
    if (event === 'close') {
      queueMicrotask(() => handler(exitCode));
    }
    return process;
  });
  return process;
};

// Mock child_process.spawn
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('DockerService', () => {
  let service: DockerService;
  let loggerService: MockProxy<LoggerService>;
  let configService: MockProxy<ConfigurationService>;
  let filesystemService: MockProxy<FilesystemService>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let appsService: MockProxy<AppsService>;
  let dockerode: MockProxy<Dockerode>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    configService = mock<ConfigurationService>();
    filesystemService = mock<FilesystemService>();
    appFilesManager = mock<AppFilesManager>();
    appsService = mock<AppsService>();
    dockerode = mock<Dockerode>();

    configService.get.mockImplementation((key) => {
      if (key === 'directories') {
        return {
          dataDir: '/data',
          appsDir: '/data/apps',
        } as any;
      }

      if (key === 'envFilePath') {
        return '/data/.env' as any;
      }

      return null as any;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DockerService,
        { provide: LoggerService, useValue: loggerService },
        { provide: ConfigurationService, useValue: configService },
        { provide: FilesystemService, useValue: filesystemService },
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: AppsService, useValue: appsService },
        { provide: DOCKERODE, useValue: dockerode },
      ],
    }).compile();

    service = module.get<DockerService>(DockerService);
  });

  afterEach(() => {
    delete process.env.CI_HUB_COMPOSE_PROJECT_NAME;
    delete process.env.ENV_FILE;
    delete process.env.UNRELATED_VAR;
    vi.clearAllMocks();
  });

  describe('getBaseComposeArgsApp', () => {
    it('should generate basic compose arguments', async () => {
      const appUrn = 'test-app' as any;

      appFilesManager.getAppEnv.mockResolvedValue({ path: '/apps/test-app/.env', content: 'FOO=BAR' });
      appFilesManager.getUserEnv.mockResolvedValue({ path: '/apps/test-app/user.env', content: null });
      appFilesManager.getDockerComposeYaml.mockResolvedValue({ path: '/apps/test-app/docker-compose.yml', content: 'services:' });
      appFilesManager.getUserComposeFile.mockResolvedValue({ path: '/apps/test-app/user-compose.yml', content: null });

      appsService.getApp.mockResolvedValue({
        app: {
          id: 'test-app',
          name: 'Test App',
          userConfigEnabled: true,
        },
      } as any);

      const result = await service.getBaseComposeArgsApp(appUrn);

      expect(result.args).toContain('--env-file');
      expect(result.args).toContain('/apps/test-app/.env');
      expect(result.args).toContain('--project-name');
      expect(result.args).toContain('test-app'); // Based on logic: appUrn.replace(':', '_') -> 'test-app' if no colon
      expect(result.args).toContain('-f');
      expect(result.args).toContain('/apps/test-app/docker-compose.yml');
      expect(result.isCustomConfig).toBe(false);
    });

    it('should include user config when enabled and present', async () => {
      const appUrn = 'test-app' as any;

      appFilesManager.getAppEnv.mockResolvedValue({ path: '/apps/test-app/.env', content: 'FOO=BAR' });
      appFilesManager.getUserEnv.mockResolvedValue({ path: '/apps/test-app/user.env', content: 'BAZ=QUX' });
      appFilesManager.getDockerComposeYaml.mockResolvedValue({ path: '/apps/test-app/docker-compose.yml', content: 'services:' });
      appFilesManager.getUserComposeFile.mockResolvedValue({ path: '/apps/test-app/user-compose.yml', content: 'services:' });

      appsService.getApp.mockResolvedValue({
        app: {
          id: 'test-app',
          name: 'Test App',
          userConfigEnabled: true,
        },
      } as any);

      const result = await service.getBaseComposeArgsApp(appUrn);

      // Should include user-env
      const userEnvIndex = result.args.indexOf('/apps/test-app/user.env');
      expect(userEnvIndex).toBeGreaterThan(-1);
      expect(result.args[userEnvIndex - 1]).toBe('--env-file');

      // Should include user-compose
      const userComposeIndex = result.args.indexOf('/apps/test-app/user-compose.yml');
      expect(userComposeIndex).toBeGreaterThan(-1);
      expect(result.args[userComposeIndex - 1]).toBe('--file');

      expect(result.isCustomConfig).toBe(true);
    });
  });

  describe('getLogsStream', () => {
    it('should tail and follow only the hub service logs with docker compose when the plugin probe succeeds', async () => {
      const probeProcess = createComposeProbeProcess(0);
      const mockSpawnProcess = createMockSpawnProcess();

      (child_process.spawn as any).mockImplementationOnce(() => probeProcess).mockImplementationOnce(() => mockSpawnProcess);

      const result = await service.getLogsStream(300);

      expect(child_process.spawn).toHaveBeenNthCalledWith(1, 'docker', ['compose', 'version'], { stdio: 'ignore' });
      expect(child_process.spawn).toHaveBeenNthCalledWith(
        2,
        'docker',
        ['compose', '--env-file', HUB_ENV_FILE, '--project-name', 'ci-hub', '-f', HUB_COMPOSE_FILE, 'logs', '--follow', '-n', '300', 'ci-os-hub'],
        { stdio: 'pipe' },
      );
      expect(result.on).toBeTypeOf('function');

      result.kill();
      expect(mockSpawnProcess.kill).toHaveBeenCalledWith('SIGINT');
    });

    it('should fall back to docker-compose for log streaming when the plugin probe fails', async () => {
      const probeProcess = createComposeProbeProcess(1);
      const fallbackProcess = createMockSpawnProcess();

      (child_process.spawn as any).mockImplementationOnce(() => probeProcess).mockImplementationOnce(() => fallbackProcess);

      const result = await service.getLogsStream(300);

      expect(child_process.spawn).toHaveBeenNthCalledWith(1, 'docker', ['compose', 'version'], { stdio: 'ignore' });
      expect(child_process.spawn).toHaveBeenNthCalledWith(
        2,
        'docker-compose',
        ['--env-file', HUB_ENV_FILE, '--project-name', 'ci-hub', '-f', HUB_COMPOSE_FILE, 'logs', '--follow', '-n', '300', 'ci-os-hub'],
        { stdio: 'pipe' },
      );
      expect(loggerService.warn).toHaveBeenCalledWith('docker compose plugin not available for logs, falling back to docker-compose binary');
      expect(result.on).toBeTypeOf('function');
      expect(result.kill).toBeTypeOf('function');
    });
  });

  describe('getLogsDownloadStream', () => {
    it('should spawn docker compose for full hub log downloads', async () => {
      const probeProcess = createComposeProbeProcess(0);
      const mockSpawnProcess = createMockSpawnProcess();

      (child_process.spawn as any).mockImplementationOnce(() => probeProcess).mockImplementationOnce(() => mockSpawnProcess);

      const result = await service.getLogsDownloadStream();

      expect(child_process.spawn).toHaveBeenNthCalledWith(1, 'docker', ['compose', 'version'], { stdio: 'ignore' });
      expect(child_process.spawn).toHaveBeenNthCalledWith(
        2,
        'docker',
        ['compose', '--env-file', HUB_ENV_FILE, '--project-name', 'ci-hub', '-f', HUB_COMPOSE_FILE, 'logs', '--no-color', 'ci-os-hub'],
        { stdio: 'pipe' },
      );
      expect(result.stdout).toBe(mockSpawnProcess.stdout);
      expect(result.stderr).toBe(mockSpawnProcess.stderr);

      result.kill();
      expect(mockSpawnProcess.kill).toHaveBeenCalledWith('SIGINT');
    });

    it('should fall back to docker-compose when docker compose exits non-zero during probing', async () => {
      const probeProcess = createComposeProbeProcess(1);
      const fallbackProcess = createMockSpawnProcess();

      (child_process.spawn as any).mockImplementationOnce(() => probeProcess).mockImplementationOnce(() => fallbackProcess);

      const result = await service.getLogsDownloadStream();

      expect(child_process.spawn).toHaveBeenNthCalledWith(1, 'docker', ['compose', 'version'], { stdio: 'ignore' });
      expect(child_process.spawn).toHaveBeenNthCalledWith(
        2,
        'docker-compose',
        ['--env-file', HUB_ENV_FILE, '--project-name', 'ci-hub', '-f', HUB_COMPOSE_FILE, 'logs', '--no-color', 'ci-os-hub'],
        { stdio: 'pipe' },
      );
      expect(loggerService.warn).toHaveBeenCalledWith('docker compose plugin not available for log download, falling back to docker-compose binary');
      expect(result.stdout).toBe(fallbackProcess.stdout);
      expect(result.stderr).toBe(fallbackProcess.stderr);
    });

    it('should honor an overridden hub compose project name', async () => {
      process.env.CI_HUB_COMPOSE_PROJECT_NAME = 'ci-hub-log-download';

      const probeProcess = createComposeProbeProcess(0);
      const mockSpawnProcess = createMockSpawnProcess();

      (child_process.spawn as any).mockImplementationOnce(() => probeProcess).mockImplementationOnce(() => mockSpawnProcess);

      await service.getLogsDownloadStream();

      expect(child_process.spawn).toHaveBeenNthCalledWith(1, 'docker', ['compose', 'version'], { stdio: 'ignore' });
      expect(child_process.spawn).toHaveBeenNthCalledWith(
        2,
        'docker',
        ['compose', '--env-file', HUB_ENV_FILE, '--project-name', 'ci-hub-log-download', '-f', HUB_COMPOSE_FILE, 'logs', '--no-color', 'ci-os-hub'],
        { stdio: 'pipe' },
      );
    });
  });

  describe('composeApp', () => {
    it('should spawn docker-compose with correct arguments', async () => {
      const appUrn = 'test-app' as any;
      const command = 'up -d';

      // Mocks for args generation
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/apps/test-app/.env', content: 'FOO=BAR' });
      appFilesManager.getUserEnv.mockResolvedValue({ path: '/apps/test-app/user.env', content: null });
      appFilesManager.getDockerComposeYaml.mockResolvedValue({ path: '/apps/test-app/docker-compose.yml', content: 'services:' });
      appFilesManager.getUserComposeFile.mockResolvedValue({ path: '/apps/test-app/user-compose.yml', content: null });
      appsService.getApp.mockResolvedValue({ app: { id: 'test-app', userConfigEnabled: true } } as any);

      const probeProcess = createComposeProbeProcess(0);
      const mockSpawnProcess = createMockSpawnProcess();
      mockSpawnProcess.on = vi.fn().mockImplementation((event, handler) => {
        if (event === 'close') {
          queueMicrotask(() => handler(0));
        }
        return mockSpawnProcess;
      });

      (child_process.spawn as any).mockImplementationOnce(() => probeProcess).mockImplementationOnce(() => mockSpawnProcess);

      await service.composeApp(appUrn, command);

      expect(child_process.spawn).toHaveBeenNthCalledWith(1, 'docker', ['compose', 'version'], { stdio: 'pipe' });
      expect(child_process.spawn).toHaveBeenNthCalledWith(
        2,
        'docker',
        expect.arrayContaining(['compose', '--project-name', 'test-app', 'up', '-d']),
        expect.objectContaining({ cwd: '/apps/test-app' }),
      );
    });
  });

  describe('ensureContainerRunning', () => {
    it('should include the hub env file when compose fallback uses the runtime hub compose file', async () => {
      process.env.ENV_FILE = '.env.dev';
      process.env.UNRELATED_VAR = 'still-here';
      vi.spyOn(service, 'restartContainer').mockRejectedValue(new Error('missing container'));

      const mockSpawnProcess = createMockSpawnProcess();
      mockSpawnProcess.on = vi.fn().mockImplementation((event, handler) => {
        if (event === 'close') {
          queueMicrotask(() => handler(0));
        }
        return mockSpawnProcess;
      });

      (child_process.spawn as any).mockReturnValue(mockSpawnProcess);

      await service.ensureContainerRunning('cloudflared', {
        composeFile: HUB_COMPOSE_FILE,
        profile: 'cloudflare',
      });

      expect(child_process.spawn).toHaveBeenCalledWith(
        'docker',
        [
          'compose',
          '--env-file',
          // composeUpService pushes the raw envFilePath config value (not path.join'd).
          '/data/.env',
          '--project-name',
          'ci-hub',
          '-f',
          HUB_COMPOSE_FILE,
          '--profile',
          'cloudflare',
          'up',
          'cloudflared',
          '-d',
          '--no-build',
          '--no-deps',
        ],
        expect.objectContaining({
          cwd: path.dirname(HUB_COMPOSE_FILE),
          env: expect.objectContaining({
            ENV_FILE: '.env',
            UNRELATED_VAR: 'still-here',
          }),
        }),
      );
    });

    it('should not include env file for non-runtime compose files', async () => {
      vi.spyOn(service, 'restartContainer').mockRejectedValue(new Error('missing container'));

      const mockSpawnProcess = createMockSpawnProcess();
      mockSpawnProcess.on = vi.fn().mockImplementation((event, handler) => {
        if (event === 'close') {
          queueMicrotask(() => handler(0));
        }
        return mockSpawnProcess;
      });

      (child_process.spawn as any).mockReturnValue(mockSpawnProcess);

      await service.ensureContainerRunning('some-service', {
        composeFile: '/other/docker-compose.yml',
      });

      expect(child_process.spawn).toHaveBeenCalledWith(
        'docker',
        ['compose', '-f', '/other/docker-compose.yml', 'up', 'some-service', '-d', '--no-build', '--no-deps'],
        expect.objectContaining({ cwd: '/other' }),
      );
    });
  });

  describe('snapshotAppImageIds', () => {
    it('should return unique image IDs from compose project containers', async () => {
      dockerode.listContainers.mockResolvedValue([{ ImageID: 'sha256:a' } as any, { ImageID: 'sha256:b' } as any, { ImageID: 'sha256:a' } as any]);

      const result = await service.snapshotAppImageIds('test:store' as any);

      expect(dockerode.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { label: ['com.docker.compose.project=test_store'] },
      });
      expect(result).toEqual(['sha256:a', 'sha256:b']);
    });
  });

  describe('getManagedAppContainerVerification', () => {
    it('returns ok when all labeled containers are running', async () => {
      dockerode.listContainers.mockResolvedValue([{ State: 'running', Status: 'Up 1 second' }] as any);

      const result = await service.getManagedAppContainerVerification('ghost:ci-marketplace' as any);

      expect(dockerode.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: {
          label: ['ci-os-hub.managed=true', 'ci-os-hub.appurn=ghost:ci-marketplace'],
        },
      });
      expect(result.ok).toBe(true);
      expect(result.appStatus).toBe('running');
    });

    it('returns missing when no labeled containers exist', async () => {
      dockerode.listContainers.mockResolvedValue([] as any);

      const result = await service.getManagedAppContainerVerification('ghost:ci-marketplace' as any);

      expect(result.ok).toBe(false);
      expect(result.appStatus).toBe('missing');
      expect(result.message).toContain('no Hub-managed containers');
    });

    it('returns stopped with container logs when containers exited', async () => {
      dockerode.listContainers.mockResolvedValue([{ State: 'exited', Status: 'Exited (1) 2 seconds ago' }] as any);
      vi.spyOn(service, 'diagnoseAppContainers').mockResolvedValue({
        unhealthy: [{ name: 'ghost', state: 'Exited (1)', logs: 'boot error' }],
        healthy: [],
      });

      const result = await service.getManagedAppContainerVerification('ghost:ci-marketplace' as any);

      expect(result.ok).toBe(false);
      expect(result.appStatus).toBe('stopped');
      expect(result.errorDetail).toContain('boot error');
    });
  });

  describe('getAppRuntimeStats', () => {
    it('should skip containers that disappear between list and inspect', async () => {
      dockerode.listContainers.mockResolvedValue([{ Id: 'gone', Names: ['/gone'], State: 'running', Status: 'Up' }] as any);
      dockerode.getContainer.mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error('404 no such container')),
      } as any);

      await expect(service.getAppRuntimeStats('test:store' as any)).resolves.toEqual([]);
      expect(loggerService.warn).toHaveBeenCalled();
    });

    it('should skip docker stats for restarting containers', async () => {
      dockerode.listContainers.mockResolvedValue([{ Id: 'loop', Names: ['/loop'], State: 'restarting', Status: 'Restarting (1)' }] as any);
      const stats = vi.fn();
      dockerode.getContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          State: { Running: false, ExitCode: 1, Health: null },
        }),
        stats,
      } as any);

      const result = await service.getAppRuntimeStats('test:store' as any);

      expect(stats).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]?.state).toBe('restarting');
      expect(result[0]?.cpuPercent).toBe(0);
    });

    it('should zero container metrics when docker stats times out', async () => {
      vi.useFakeTimers();
      try {
        dockerode.listContainers.mockResolvedValue([{ Id: 'slow', Names: ['/slow'], State: 'running', Status: 'Up' }] as any);
        dockerode.getContainer.mockReturnValue({
          inspect: vi.fn().mockResolvedValue({
            State: { Running: true, Health: null },
          }),
          stats: vi.fn(
            () =>
              new Promise(() => {
                /* never resolves */
              }),
          ),
        } as any);

        const resultPromise = service.getAppRuntimeStats('test:store' as any);
        await vi.advanceTimersByTimeAsync(5_100);
        const result = await resultPromise;
        expect(result).toHaveLength(1);
        expect(result[0]?.cpuPercent).toBe(0);
        expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('should skip container when docker inspect times out', async () => {
      vi.useFakeTimers();
      try {
        dockerode.listContainers.mockResolvedValue([{ Id: 'stuck', Names: ['/stuck'], State: 'running', Status: 'Up' }] as any);
        dockerode.getContainer.mockReturnValue({
          inspect: vi.fn(
            () =>
              new Promise(() => {
                /* never resolves */
              }),
          ),
          stats: vi.fn(),
        } as any);

        const resultPromise = service.getAppRuntimeStats('test:store' as any);
        await vi.advanceTimersByTimeAsync(5_100);
        const result = await resultPromise;
        expect(result).toEqual([]);
        expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('forceStopApp', () => {
    it('should default to a 10 second graceful stop before escalation', async () => {
      dockerode.listContainers.mockResolvedValue([{ Id: 'abc', Names: ['/svc'], State: 'running', Status: 'Up' }] as any);
      const stop = vi.fn().mockResolvedValue(undefined);
      const kill = vi.fn().mockResolvedValue(undefined);
      dockerode.getContainer.mockReturnValue({ stop, kill } as any);

      await expect(service.forceStopApp('test:store' as any)).resolves.toEqual({ stopped: ['svc'], killed: [] });
      expect(stop).toHaveBeenCalledWith({ t: 10 });
      expect(kill).not.toHaveBeenCalled();
    });
  });

  describe('removeAppImages', () => {
    it('should remove snapshot and labeled images with dedupe', async () => {
      dockerode.listImages.mockResolvedValue([{ Id: 'sha256:b' }, { Id: 'sha256:c' }] as any);

      const removeA = vi.fn().mockResolvedValue(undefined);
      const removeB = vi.fn().mockResolvedValue(undefined);
      const removeC = vi.fn().mockResolvedValue(undefined);

      dockerode.getImage.mockImplementation((id: string) => {
        if (id === 'sha256:a') return { remove: removeA } as any;
        if (id === 'sha256:b') return { remove: removeB } as any;
        return { remove: removeC } as any;
      });

      await service.removeAppImages('test:store' as any, ['sha256:a', 'sha256:b']);

      expect(dockerode.listImages).toHaveBeenCalledWith({
        filters: { label: ['com.docker.compose.project=test_store'] },
      });
      expect(removeA).toHaveBeenCalledWith({ force: true });
      expect(removeB).toHaveBeenCalledWith({ force: true });
      expect(removeC).toHaveBeenCalledWith({ force: true });
    });

    it('should swallow not found and in use removal errors', async () => {
      dockerode.listImages.mockResolvedValue([] as any);

      const removeMissing = vi.fn().mockRejectedValue(new Error('No such image: sha256:a'));
      const removeInUse = vi.fn().mockRejectedValue(new Error('image is being used by running container'));

      dockerode.getImage.mockImplementation((id: string) => {
        if (id === 'sha256:a') return { remove: removeMissing } as any;
        return { remove: removeInUse } as any;
      });

      await expect(service.removeAppImages('test:store' as any, ['sha256:a', 'sha256:b'])).resolves.toBeUndefined();
      expect(loggerService.warn).toHaveBeenCalled();
    });
  });

  describe('removeAppNetworks', () => {
    it('should skip shared and external networks, and remove app-owned networks', async () => {
      dockerode.listNetworks.mockResolvedValue([
        { Id: '1', Name: 'test_store_default', Labels: {} },
        { Id: '2', Name: 'ci-os-hub_network', Labels: {} },
        { Id: '3', Name: 'test_store_external', Labels: { 'com.docker.compose.network.external': 'true' } },
      ] as any);

      const remove = vi.fn().mockResolvedValue(undefined);
      dockerode.getNetwork.mockImplementation((id: string) => ({ remove: id === '1' ? remove : vi.fn() }) as any);

      await service.removeAppNetworks('test:store' as any);

      expect(dockerode.listNetworks).toHaveBeenCalledWith({
        filters: { label: ['com.docker.compose.project=test_store'] },
      });
      expect(remove).toHaveBeenCalledTimes(1);
    });

    it('should swallow active endpoint errors during network removal', async () => {
      dockerode.listNetworks.mockResolvedValue([{ Id: '1', Name: 'test_store_default', Labels: {} }] as any);
      const remove = vi.fn().mockRejectedValue(new Error('network has active endpoints'));
      dockerode.getNetwork.mockReturnValue({ remove } as any);

      await expect(service.removeAppNetworks('test:store' as any)).resolves.toBeUndefined();
      expect(loggerService.warn).toHaveBeenCalled();
    });
  });

  describe('getAppNetworkTarget', () => {
    it('returns the direct container target using the Traefik service port label', async () => {
      dockerode.listContainers.mockResolvedValue([{ Id: 'abc123' }] as any);
      dockerode.getContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          Config: {
            Labels: {
              'traefik.enable': 'true',
              'traefik.http.services.anything-llm-ci-marketplace.loadbalancer.server.port': '3001',
            },
          },
          NetworkSettings: {
            Networks: {
              'ci-os-hub_network': {
                IPAddress: '172.18.0.10',
              },
            },
          },
        }),
      } as any);

      await expect(service.getAppNetworkTarget('anything-llm:ci-marketplace' as any)).resolves.toEqual({
        url: 'http://172.18.0.10:3001',
        internalPort: 3001,
      });

      expect(dockerode.listContainers).toHaveBeenCalledWith({
        all: false,
        filters: {
          label: ['ci-os-hub.appurn=anything-llm:ci-marketplace', 'traefik.enable=true'],
        },
      });
    });
  });
});
