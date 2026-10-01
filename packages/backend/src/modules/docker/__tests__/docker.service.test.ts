import { Test, TestingModule } from '@nestjs/testing';
import { ComposeCliUnavailableError, DockerService } from '../docker.service';
import { DockerReadFacade } from '../docker-read.facade';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppsRepository } from '../../apps/apps.repository';
import { DOCKERODE } from '../constants';
import { getAppDataHostPath } from '@/common/helpers/app-data-path.helper';
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
  let dockerReadFacade: DockerReadFacade;
  let loggerService: MockProxy<LoggerService>;
  let configService: MockProxy<ConfigurationService>;
  let filesystemService: MockProxy<FilesystemService>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let appsRepository: MockProxy<AppsRepository>;
  let dockerode: MockProxy<Dockerode>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    configService = mock<ConfigurationService>();
    filesystemService = mock<FilesystemService>();
    appFilesManager = mock<AppFilesManager>();
    appsRepository = mock<AppsRepository>();
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
        DockerReadFacade,
        DockerService,
        { provide: LoggerService, useValue: loggerService },
        { provide: ConfigurationService, useValue: configService },
        { provide: FilesystemService, useValue: filesystemService },
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: AppsRepository, useValue: appsRepository },
        { provide: DOCKERODE, useValue: dockerode },
      ],
    }).compile();

    service = module.get<DockerService>(DockerService);
    dockerReadFacade = module.get(DockerReadFacade);
  });

  afterEach(() => {
    delete process.env.CI_HUB_COMPOSE_PROJECT_NAME;
    delete process.env.ENV_FILE;
    delete process.env.UNRELATED_VAR;
    // Reset spawn's implementation (not just call history) so a persistent
    // mockImplementation from one test cannot leak into the next.
    (child_process.spawn as any).mockReset();
    vi.clearAllMocks();
  });

  describe('getBaseComposeArgsApp', () => {
    it('should generate basic compose arguments', async () => {
      const appUrn = 'test-app' as any;

      appFilesManager.getAppEnv.mockResolvedValue({ path: '/apps/test-app/.env', content: 'FOO=BAR' });
      appFilesManager.getUserEnv.mockResolvedValue({ path: '/apps/test-app/user.env', content: null });
      appFilesManager.getDockerComposeYaml.mockResolvedValue({ path: '/apps/test-app/docker-compose.yml', content: 'services:' });
      appFilesManager.getUserComposeFile.mockResolvedValue({ path: '/apps/test-app/user-compose.yml', content: null });

      appsRepository.getAppByUrn.mockResolvedValue({
        id: 'test-app',
        name: 'Test App',
        userConfigEnabled: true,
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

      appsRepository.getAppByUrn.mockResolvedValue({
        id: 'test-app',
        name: 'Test App',
        userConfigEnabled: true,
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
        ['compose', '--env-file', HUB_ENV_FILE, '--project-name', 'ci-hub', '-f', HUB_COMPOSE_FILE, 'logs', '--follow', '-n', '300', 'ci-hub'],
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
        ['--env-file', HUB_ENV_FILE, '--project-name', 'ci-hub', '-f', HUB_COMPOSE_FILE, 'logs', '--follow', '-n', '300', 'ci-hub'],
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
        ['compose', '--env-file', HUB_ENV_FILE, '--project-name', 'ci-hub', '-f', HUB_COMPOSE_FILE, 'logs', '--no-color', 'ci-hub'],
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
        ['--env-file', HUB_ENV_FILE, '--project-name', 'ci-hub', '-f', HUB_COMPOSE_FILE, 'logs', '--no-color', 'ci-hub'],
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
        ['compose', '--env-file', HUB_ENV_FILE, '--project-name', 'ci-hub-log-download', '-f', HUB_COMPOSE_FILE, 'logs', '--no-color', 'ci-hub'],
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
      appsRepository.getAppByUrn.mockResolvedValue({ id: 'test-app', userConfigEnabled: true } as any);

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

    it('detaches the Hub before compose down, and attaches it only after a successful up', async () => {
      const appUrn = 'test-app' as any;
      mockComposeArgResolution();
      const detach = vi.spyOn(service, 'detachHubFromAppNetworks').mockResolvedValue(undefined);
      const attach = vi.spyOn(service, 'attachHubToAppNetworks').mockResolvedValue(undefined);

      const spawnCompose = () => {
        const probeProcess = createComposeProbeProcess(0);
        const mockSpawnProcess = createMockSpawnProcess();
        mockSpawnProcess.on = vi.fn().mockImplementation((event, handler) => {
          if (event === 'close') {
            queueMicrotask(() => handler(0));
          }
          return mockSpawnProcess;
        });
        (child_process.spawn as any).mockImplementationOnce(() => probeProcess).mockImplementationOnce(() => mockSpawnProcess);
      };

      try {
        spawnCompose();
        await service.composeApp(appUrn, 'down --remove-orphans');
        expect(detach).toHaveBeenCalledWith(appUrn);
        expect(attach).not.toHaveBeenCalled();
        expect(detach.mock.invocationCallOrder[0]).toBeLessThan((child_process.spawn as any).mock.invocationCallOrder[0]);

        detach.mockClear();
        (child_process.spawn as any).mockReset();
        spawnCompose();
        await service.composeApp(appUrn, 'up -d');
        expect(detach).not.toHaveBeenCalled();
        expect(attach).toHaveBeenCalledWith(appUrn);
        expect(attach.mock.invocationCallOrder[0]).toBeGreaterThan((child_process.spawn as any).mock.invocationCallOrder.at(-1));
      } finally {
        detach.mockRestore();
        attach.mockRestore();
      }
    });

    const mockComposeArgResolution = () => {
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/apps/test-app/.env', content: 'FOO=BAR' });
      appFilesManager.getUserEnv.mockResolvedValue({ path: '/apps/test-app/user.env', content: null });
      appFilesManager.getDockerComposeYaml.mockResolvedValue({ path: '/apps/test-app/docker-compose.yml', content: 'services:' });
      appFilesManager.getUserComposeFile.mockResolvedValue({ path: '/apps/test-app/user-compose.yml', content: null });
      appsRepository.getAppByUrn.mockResolvedValue({ id: 'test-app', userConfigEnabled: true } as any);
    };

    // A child that never emits 'close' or output on its own, but exits (killed-by-signal → null
    // code) once our own SIGKILL escalation calls kill('SIGKILL') — simulates a wedged daemon/volume.
    const createHungProcess = () => {
      const proc = createMockSpawnProcess();
      proc.kill = vi.fn().mockImplementation((signal?: string) => {
        if (signal === 'SIGKILL') {
          queueMicrotask(() => proc.emit('close', null));
        }
      });
      return proc;
    };

    it('aborts and fails (not cancels) a hung process with no output within the inactivity window', async () => {
      vi.useFakeTimers();
      try {
        mockComposeArgResolution();
        const probeProcess = createComposeProbeProcess(0);
        const hungProcess = createHungProcess();
        (child_process.spawn as any).mockImplementationOnce(() => probeProcess).mockImplementationOnce(() => hungProcess);

        const resultPromise = service.composeApp('test-app' as any, 'up -d');
        const assertion = expect(resultPromise).rejects.toThrow(/produced no output for 10 minutes/);

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // inactivity timeout → abort
        await vi.advanceTimersByTimeAsync(5_000); // COMPOSE_CANCEL_SIGKILL_GRACE_MS → SIGKILL → close(null)

        await assertion;
        expect(hungProcess.kill).toHaveBeenCalledWith('SIGKILL');
      } finally {
        vi.useRealTimers();
      }
    });

    it('aborts and fails a process that exceeds the overall budget despite periodic output', async () => {
      vi.useFakeTimers();
      try {
        mockComposeArgResolution();
        const probeProcess = createComposeProbeProcess(0);
        const hungProcess = createHungProcess();
        (child_process.spawn as any).mockImplementationOnce(() => probeProcess).mockImplementationOnce(() => hungProcess);

        const resultPromise = service.composeApp('test-app' as any, 'up -d');
        const assertion = expect(resultPromise).rejects.toThrow(/exceeded the 45-minute budget/);

        // Emit output every 9 minutes (under the 10-minute inactivity window) so only the 45-minute
        // overall budget can fire — 5 steps = 45 minutes total.
        for (let i = 0; i < 5; i++) {
          await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
          hungProcess.stdout.emit('data', Buffer.from('still working\n'));
        }
        await vi.advanceTimersByTimeAsync(5_000); // COMPOSE_CANCEL_SIGKILL_GRACE_MS → SIGKILL → close(null)

        await assertion;
        expect(hungProcess.kill).toHaveBeenCalledWith('SIGKILL');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('ensureContainerRunning', () => {
    it('should include the hub env file when compose up uses the runtime hub compose file', async () => {
      process.env.ENV_FILE = '.env.dev';
      process.env.UNRELATED_VAR = 'still-here';

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
          label: ['ci-hub.managed=true', 'ci-hub.appurn=ghost:ci-marketplace'],
        },
      });
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
      vi.spyOn(dockerReadFacade, 'diagnoseAppContainers').mockResolvedValue({
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
          label: ['ci-hub.appurn=anything-llm:ci-marketplace', 'traefik.enable=true'],
        },
      });
      expect(dockerode.listContainers).toHaveBeenCalledWith({
        all: false,
        filters: {
          label: ['ci-os-hub.appurn=anything-llm:ci-marketplace', 'traefik.enable=true'],
        },
      });
    });
  });

  describe('composeUpService (bounded up)', () => {
    const procClosing = (code: number, stderr = '') => {
      const proc = createMockSpawnProcess();
      proc.on = vi.fn().mockImplementation((event, handler) => {
        if (event === 'close') {
          queueMicrotask(() => {
            if (stderr) {
              proc.stderr.emit('data', Buffer.from(stderr));
            }
            handler(code);
          });
        }
        return proc;
      });
      return proc;
    };

    // A child that ignores SIGTERM but exits (killed-by-signal → null code) on SIGKILL.
    const procKilledOnSigkill = () => {
      const proc = createMockSpawnProcess();
      let onClose: ((code: number | null) => void) | undefined;
      proc.on = vi.fn().mockImplementation((event, handler) => {
        if (event === 'close') {
          onClose = handler;
        }
        return proc;
      });
      proc.kill = vi.fn().mockImplementation((signal?: string) => {
        if (signal === 'SIGKILL') {
          queueMicrotask(() => onClose?.(null));
        }
      });
      return proc;
    };

    // A child whose spawn fails (e.g. ENOENT): emits 'error', never 'close'.
    const procErroring = (message = 'spawn docker ENOENT') => {
      const proc = createMockSpawnProcess();
      proc.on = vi.fn().mockImplementation((event, handler) => {
        if (event === 'error') {
          queueMicrotask(() => handler(new Error(message)));
        }
        return proc;
      });
      return proc;
    };

    const isVersionProbe = (args: unknown) => Array.isArray(args) && args[args.length - 1] === 'version';
    const upCallsOf = () => ((child_process.spawn as any).mock.calls as any[][]).filter((c) => Array.isArray(c[1]) && c[1].includes('up'));

    /** Every `... version` probe succeeds; every other spawn comes from `other`. */
    const withComposePlugin = (other: () => any) =>
      (child_process.spawn as any).mockImplementation((_cmd: string, args: string[]) => (isVersionProbe(args) ? procClosing(0) : other()));

    it('force-recreates after a stale-network compose up failure', async () => {
      (child_process.spawn as any)
        // docker compose version probe
        .mockImplementationOnce(() => procClosing(0))
        // Initial compose up (2 attempts) — both report the deleted-network error.
        .mockImplementationOnce(() => procClosing(1, 'Error response from daemon: failed to set up container networking: network abcdef not found'))
        .mockImplementationOnce(() => procClosing(1, 'Error response from daemon: failed to set up container networking: network abcdef not found'))
        // docker rm -f
        .mockImplementationOnce(() => procClosing(0))
        // Force-recreate compose up
        .mockImplementationOnce(() => procClosing(0));

      await expect(service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare' })).resolves.toBeUndefined();

      const calls = (child_process.spawn as any).mock.calls as any[][];
      const upCalls = calls.filter((c) => Array.isArray(c[1]) && c[1].includes('up'));
      const rmCalls = calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'rm' && c[1].includes('-f'));
      expect(rmCalls.length).toBe(1);
      expect(upCalls.length).toBe(3); // 2 failed + 1 force-recreate
      expect(upCalls[2][1]).toEqual(expect.arrayContaining(['--force-recreate']));
    });

    it('goes through compose up, not docker restart, so a container from an older definition is replaced (beta-max cloudflared 530)', async () => {
      // beta-max: `docker restart cloudflared` exited 0 on every boot while the container, created
      // from a definition whose token mount had since moved, crash-looped on "Failed to read token
      // file". A restart that "succeeds" must not be what decides the service is fine.
      const restart = vi.spyOn(service, 'restartContainer').mockResolvedValue(undefined);
      withComposePlugin(() => procClosing(0));

      await service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare' });

      expect(restart).not.toHaveBeenCalled();
      expect(upCallsOf()).toHaveLength(1);
      // Plain `up`: compose recreates only when the config hash differs, so a healthy tunnel is not bounced.
      expect(upCallsOf()[0][1]).not.toContain('--force-recreate');
    });

    it('force-recreates when the caller just rewrote a file the service reads only at startup (tunnel token)', async () => {
      withComposePlugin(() => procClosing(0));

      await service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare', forceRecreate: true });

      expect(upCallsOf()[0][1]).toEqual(expect.arrayContaining(['up', 'cloudflared', '--force-recreate']));
    });

    it('falls back to the docker-compose binary when the plugin is missing, instead of failing with "unknown flag: --env-file"', async () => {
      // beta-ms-a2 / beta-red / beta-max, 2026-09-17: /data/.docker had no cli-plugins directory, so
      // `docker compose` was not a command, while /usr/local/bin/docker-compose was present.
      (child_process.spawn as any).mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[0] === 'compose') {
          return procClosing(125, "unknown flag: --env-file\nSee 'docker --help'.");
        }
        return procClosing(0);
      });

      await expect(service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare' })).resolves.toBeUndefined();

      const up = upCallsOf();
      expect(up).toHaveLength(1);
      expect(up[0][0]).toBe('docker-compose');
      expect(up[0][1][0]).toBe('--env-file');
      expect(up[0][1]).toEqual(expect.arrayContaining(['--project-name', 'ci-hub', '--profile', 'cloudflare', 'up', 'cloudflared', '-d']));
    });

    it('names the missing compose plugin when no compose CLI works and there is no container to restart', async () => {
      vi.spyOn(service, 'restartContainer').mockRejectedValue(new Error('Failed to restart container cloudflared'));
      (child_process.spawn as any).mockImplementation((cmd: string) =>
        cmd === 'docker-compose' ? procErroring('spawn docker-compose ENOENT') : procClosing(1, "docker: 'compose' is not a docker command."),
      );

      const result = service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare' });

      await expect(result).rejects.toBeInstanceOf(ComposeCliUnavailableError);
      await expect(result).rejects.toThrow(/is not a docker command.*docker-compose ENOENT.*unknown flag: --env-file.*cli-plugins/s);
      expect(upCallsOf()).toHaveLength(0);
    });

    it('still restarts an existing container when no compose CLI works, and logs why its definition was not checked', async () => {
      const restart = vi.spyOn(service, 'restartContainer').mockResolvedValue(undefined);
      (child_process.spawn as any).mockImplementation((cmd: string) =>
        cmd === 'docker-compose' ? procErroring('spawn docker-compose ENOENT') : procClosing(1, "docker: 'compose' is not a docker command."),
      );

      await expect(service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare' })).resolves.toBeUndefined();

      expect(restart).toHaveBeenCalledWith('cloudflared');
      expect(loggerService.error).toHaveBeenCalledWith(expect.stringContaining('no Docker Compose CLI works in this Hub'));
    });

    it('brings the service up via a single docker compose up (up pulls on demand; no separate pull)', async () => {
      withComposePlugin(() => procClosing(0));

      await service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare' });

      const calls = (child_process.spawn as any).mock.calls as any[][];
      const upCalls = calls.filter((c) => Array.isArray(c[1]) && c[1].includes('up'));
      // Exactly one `up`, and no separate `pull` — `up` respects pull_policy itself,
      // so a cached/baked image starts with no registry round-trip.
      expect(upCalls.length).toBe(1);
      expect(calls.some((c) => Array.isArray(c[1]) && c[1].includes('pull'))).toBe(false);
      expect(upCalls[0][1]).toEqual(
        expect.arrayContaining(['compose', '--profile', 'cloudflare', 'up', 'cloudflared', '-d', '--no-build', '--no-deps']),
      );
    });

    it('retries compose up after a transient failure', async () => {
      (child_process.spawn as any)
        .mockImplementationOnce(() => procClosing(0)) // docker compose version probe
        .mockImplementationOnce(() => procClosing(1)) // up attempt 1 fails
        .mockImplementationOnce(() => procClosing(0)); // up attempt 2 succeeds

      await expect(service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare' })).resolves.toBeUndefined();

      const calls = (child_process.spawn as any).mock.calls as any[][];
      const upCalls = calls.filter((c) => Array.isArray(c[1]) && c[1].includes('up'));
      expect(upCalls.length).toBe(2);
    });

    it('rejects (with the exit code) after both up attempts exit non-zero', async () => {
      withComposePlugin(() => procClosing(1)); // every up attempt fails

      await expect(service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare' })).rejects.toThrow(/exit 1/);

      const calls = (child_process.spawn as any).mock.calls as any[][];
      const upCalls = calls.filter((c) => Array.isArray(c[1]) && c[1].includes('up'));
      expect(upCalls.length).toBe(2); // COMPOSE_OP_MAX_ATTEMPTS
    });

    it('rejects (and retries) when the child process fails to spawn', async () => {
      withComposePlugin(() => procErroring());

      await expect(service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare' })).rejects.toThrow(/ENOENT/);

      const calls = (child_process.spawn as any).mock.calls as any[][];
      const upCalls = calls.filter((c) => Array.isArray(c[1]) && c[1].includes('up'));
      expect(upCalls.length).toBe(2); // error is retried
    });

    it('on timeout, escalates SIGTERM→SIGKILL and rejects once the child exits (normal path)', async () => {
      vi.useFakeTimers();
      try {
        // Child ignores SIGTERM, exits on SIGKILL — so the `close` handler (not the backstop) rejects.
        const proc = procKilledOnSigkill();
        withComposePlugin(() => proc);

        const resultPromise = service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare' });
        const assertion = expect(resultPromise).rejects.toThrow(/timed out/);

        // Per attempt: 300s timeout → SIGTERM, +5s SIGKILL → child exits (null code) → close rejects 'timed out'.
        await vi.advanceTimersByTimeAsync(310_000); // attempt 1
        await vi.advanceTimersByTimeAsync(310_000); // attempt 2 → throw

        await assertion;
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      } finally {
        vi.useRealTimers();
      }
    });

    it('unblocks via the hard backstop if a killed child never exits', async () => {
      vi.useFakeTimers();
      try {
        const hungUp = createMockSpawnProcess();
        hungUp.on = vi.fn().mockReturnValue(hungUp); // never emits close/error
        withComposePlugin(() => hungUp);

        const resultPromise = service.ensureContainerRunning('cloudflared', { composeFile: HUB_COMPOSE_FILE, profile: 'cloudflare' });
        const assertion = expect(resultPromise).rejects.toThrow(/timed out/);

        // Each attempt: 300s timeout → SIGTERM, +5s SIGKILL, +5s hard backstop reject (~310s), then retry.
        await vi.advanceTimersByTimeAsync(320_000); // attempt 1
        await vi.advanceTimersByTimeAsync(320_000); // attempt 2 → throw

        await assertion;
        // 2 attempts × (SIGTERM then SIGKILL), in order.
        expect(hungUp.kill).toHaveBeenCalledTimes(4);
        expect(hungUp.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
        expect(hungUp.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
        expect(hungUp.kill).toHaveBeenNthCalledWith(3, 'SIGTERM');
        expect(hungUp.kill).toHaveBeenNthCalledWith(4, 'SIGKILL');
      } finally {
        vi.useRealTimers();
      }
    });

    describe('removeContainer', () => {
      it('force-removes the container and reports success', async () => {
        (child_process.spawn as any).mockImplementation(() => procClosing(0));

        await expect(service.removeContainer('cloudflared')).resolves.toBe(true);

        expect(child_process.spawn).toHaveBeenCalledWith('docker', ['rm', '-f', 'cloudflared'], {});
      });

      it('counts a container that does not exist as removed', async () => {
        (child_process.spawn as any).mockImplementation(() => procClosing(1, 'Error response from daemon: No such container: cloudflared'));

        await expect(service.removeContainer('cloudflared')).resolves.toBe(true);
      });

      it('reports failure without throwing when Docker cannot remove it', async () => {
        (child_process.spawn as any).mockImplementation(() =>
          procClosing(1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'),
        );

        await expect(service.removeContainer('cloudflared')).resolves.toBe(false);
      });
    });

    describe('readContainerLabel', () => {
      const LABEL = 'com.docker.compose.project.working_dir';
      const inspectAnswer = (code: number, stdout: string, stderr = '') => {
        const proc = createMockSpawnProcess();
        proc.on = vi.fn().mockImplementation((event, handler) => {
          if (event === 'close') {
            queueMicrotask(() => {
              if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
              if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
              handler(code);
            });
          }
          return proc;
        });
        return proc;
      };

      it("reads the label from the container's config", async () => {
        (child_process.spawn as any).mockImplementation(() => inspectAnswer(0, '/home/someone/.local/share/companion-hub\n'));

        await expect(dockerReadFacade.readContainerLabel('cloudflared', LABEL)).resolves.toEqual({
          found: true,
          value: '/home/someone/.local/share/companion-hub',
        });
        expect(child_process.spawn).toHaveBeenCalledWith('docker', [
          'inspect',
          '--type',
          'container',
          '--format',
          `{{ index .Config.Labels "${LABEL}" }}`,
          'cloudflared',
        ]);
      });

      it('reads a label the container does not have as null', async () => {
        (child_process.spawn as any).mockImplementation(() => inspectAnswer(0, '<no value>\n'));

        await expect(dockerReadFacade.readContainerLabel('cloudflared', LABEL)).resolves.toEqual({ found: true, value: null });
      });

      it('tells a missing container apart from Docker being unavailable', async () => {
        (child_process.spawn as any).mockImplementationOnce(() => inspectAnswer(1, '', 'Error: No such container: cloudflared'));
        await expect(dockerReadFacade.readContainerLabel('cloudflared', LABEL)).resolves.toEqual({ found: false });

        (child_process.spawn as any).mockImplementationOnce(() =>
          inspectAnswer(1, '', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.'),
        );
        await expect(dockerReadFacade.readContainerLabel('cloudflared', LABEL)).resolves.toBeNull();
      });
    });
  });

  describe('removeAppDataDirAsRoot (privileged uninstall-remnant cleanup)', () => {
    const validUrn = 'ci-memory:ci-marketplace' as any;
    const inputs = { ciHubAppDataPath: undefined, appDataPath: undefined, rootFolderHost: '/host/root' };

    beforeEach(() => {
      configService.getConfig.mockReturnValue({ userSettings: {}, rootFolderHost: '/host/root' } as any);
      delete process.env.CI_HUB_APP_DATA_PATH;
      delete process.env.CI_HUB_CLEANUP_IMAGE;
    });

    afterEach(() => {
      delete process.env.CI_HUB_CLEANUP_IMAGE;
    });

    it('runs a root, no-network, --rm helper that mounts ONLY the app data dir and empties it', async () => {
      (child_process.spawn as any).mockReturnValue(createComposeProbeProcess(0));

      const hostDir = getAppDataHostPath(validUrn, inputs);
      const ok = await service.removeAppDataDirAsRoot(validUrn);

      expect(ok).toBe(true);
      expect(child_process.spawn).toHaveBeenCalledWith(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--user',
          '0:0',
          '-v',
          `${hostDir}:/target:rw`,
          'alpine:3.20',
          'find',
          '/target',
          '-mindepth',
          '1',
          '-delete',
        ],
        { stdio: 'pipe' },
      );
    });

    it('returns false when the helper container exits non-zero', async () => {
      (child_process.spawn as any).mockReturnValue(createComposeProbeProcess(1));

      await expect(service.removeAppDataDirAsRoot(validUrn)).resolves.toBe(false);
    });

    it('refuses (and never spawns) when the resolved path is not exactly {app-data-root}/{store}/{app}', async () => {
      // An unsafe app-name segment ('..') must be rejected by the guardrails.
      const ok = await service.removeAppDataDirAsRoot('..:ci-marketplace' as any);

      expect(ok).toBe(false);
      expect(child_process.spawn).not.toHaveBeenCalled();
    });

    it('honors the CI_HUB_CLEANUP_IMAGE override', async () => {
      process.env.CI_HUB_CLEANUP_IMAGE = 'busybox:1.36';
      (child_process.spawn as any).mockReturnValue(createComposeProbeProcess(0));

      await service.removeAppDataDirAsRoot(validUrn);

      expect(child_process.spawn).toHaveBeenCalledWith('docker', expect.arrayContaining(['busybox:1.36']), { stdio: 'pipe' });
    });
  });

  describe('createPreUpdateVolumeSnapshot', () => {
    const testUrn = 'test-app:test-store' as any;

    beforeEach(() => {
      appFilesManager.getAppPaths.mockReturnValue({
        appDataDir: '/data/app-data/test-store/test-app',
        appInstalledDir: '/data/apps/test-store/test-app',
      } as any);
      dockerode.listContainers.mockResolvedValue([]);
      dockerode.listVolumes.mockResolvedValue({ Volumes: [] } as any);
    });

    it('snapshots app data directory and registers docker volumes when data exists', async () => {
      filesystemService.pathExists.mockResolvedValue(true);
      filesystemService.createDirectory.mockResolvedValue(true);
      filesystemService.copyDirectory.mockResolvedValue(true);

      dockerode.listContainers.mockResolvedValue([
        {
          Id: 'c1',
          Mounts: [
            {
              Type: 'volume',
              Name: 'test-app_dbdata',
              Source: '/var/lib/docker/volumes/test-app_dbdata/_data',
              Destination: '/var/lib/postgresql/data',
            },
          ],
        } as any,
      ]);

      dockerode.listVolumes.mockResolvedValue({
        Volumes: [
          {
            Name: 'test-app_dbdata',
            Mountpoint: '/var/lib/docker/volumes/test-app_dbdata/_data',
          } as any,
        ],
      } as any);

      const result = await service.createPreUpdateVolumeSnapshot(testUrn);

      expect(result.success).toBe(true);
      expect(result.appUrn).toBe(testUrn);
      expect(result.snapshotPath).toContain('snapshots');
      expect(filesystemService.createDirectory).toHaveBeenCalled();
      expect(filesystemService.copyDirectory).toHaveBeenCalledWith('/data/app-data/test-store/test-app', expect.stringContaining('snapshots'));
      expect(result.volumes.some((v) => v.type === 'bind')).toBe(true);
      expect(result.volumes.some((v) => v.name === 'test-app_dbdata')).toBe(true);
    });

    it('succeeds gracefully when app data directory does not exist yet', async () => {
      filesystemService.pathExists.mockResolvedValue(false);

      const result = await service.createPreUpdateVolumeSnapshot(testUrn);

      expect(result.success).toBe(true);
      expect(result.snapshotPath).toBeUndefined();
      expect(filesystemService.copyDirectory).not.toHaveBeenCalled();
    });

    it('also snapshots the installed app files dir, so a rollback can restore the previous compose/version too', async () => {
      filesystemService.pathExists.mockResolvedValue(true);
      filesystemService.createDirectory.mockResolvedValue(true);
      filesystemService.copyDirectory.mockResolvedValue(true);

      const result = await service.createPreUpdateVolumeSnapshot(testUrn);

      expect(result.appFilesSnapshotPath).toContain('snapshots');
      expect(filesystemService.copyDirectory).toHaveBeenCalledWith('/data/apps/test-store/test-app', expect.stringContaining('snapshots'));
    });

    it('skips the data folder when asked, since a backup already holds it', async () => {
      filesystemService.pathExists.mockResolvedValue(true);
      filesystemService.createDirectory.mockResolvedValue(true);
      filesystemService.copyDirectory.mockResolvedValue(true);

      const result = await service.createPreUpdateVolumeSnapshot(testUrn, { includeData: false });

      expect(result.success).toBe(true);
      expect(result.snapshotPath).toBeUndefined();
      expect(result.appFilesSnapshotPath).toContain('snapshots');
      expect(filesystemService.copyDirectory).toHaveBeenCalledTimes(1);
      expect(filesystemService.copyDirectory).toHaveBeenCalledWith('/data/apps/test-store/test-app', expect.stringContaining('snapshots'));
    });

    it('names the folder holding everything it wrote, so the whole snapshot can be removed at once', async () => {
      filesystemService.pathExists.mockResolvedValue(true);
      filesystemService.createDirectory.mockResolvedValue(true);
      filesystemService.copyDirectory.mockResolvedValue(true);

      const result = await service.createPreUpdateVolumeSnapshot(testUrn);

      expect(result.snapshotBaseDir).toBeDefined();
      expect(result.snapshotPath?.startsWith(result.snapshotBaseDir as string)).toBe(true);
      expect(result.appFilesSnapshotPath?.startsWith(result.snapshotBaseDir as string)).toBe(true);
    });

    // `copyDirectory` reports ENOSPC and EACCES by returning false. Reading that as success handed a
    // half-copied folder to a rollback, which then restored it over the app.
    it.each([
      ['the data folder', '/data/app-data/test-store/test-app'],
      ['the installed files', '/data/apps/test-store/test-app'],
    ])('is not a success when copying %s fails, and removes what it wrote', async (_name, failingSource) => {
      filesystemService.pathExists.mockResolvedValue(true);
      filesystemService.createDirectory.mockResolvedValue(true);
      filesystemService.removeDirectory.mockResolvedValue(true);
      filesystemService.copyDirectory.mockImplementation(async (source: string) => source !== failingSource);

      const result = await service.createPreUpdateVolumeSnapshot(testUrn);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not copy');
      expect(result.appFilesSnapshotPath).toBeUndefined();
      expect(filesystemService.removeDirectory).toHaveBeenCalledWith(expect.stringContaining('snapshots'));
    });

    it('handles container listing errors without throwing', async () => {
      filesystemService.pathExists.mockResolvedValue(false);
      dockerode.listContainers.mockRejectedValue(new Error('Docker daemon unavailable'));

      const result = await service.createPreUpdateVolumeSnapshot(testUrn);

      expect(result.success).toBe(true);
      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to list containers'));
    });
  });

  describe('verifyContainerHealthProbe', () => {
    const testUrn = 'test-app:test-store' as any;

    it('returns ok and healthy when all containers with health checks are healthy', async () => {
      dockerode.listContainers.mockResolvedValue([
        {
          Id: 'c1',
          Names: ['/test-app-web'],
          State: 'running',
          Status: 'Up 2 minutes (healthy)',
        } as any,
      ]);

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue({
          State: {
            Status: 'running',
            Running: true,
            Health: {
              Status: 'healthy',
              FailingStreak: 0,
              Log: [{ Output: 'HTTP 200 OK' }],
            },
          },
        }),
      };
      dockerode.getContainer.mockReturnValue(mockContainer as any);

      const result = await service.verifyContainerHealthProbe(testUrn);

      expect(result.ok).toBe(true);
      expect(result.healthy).toBe(true);
      expect(result.containers[0].healthStatus).toBe('healthy');
      expect(result.message).toContain('passed health probes');
    });

    it('returns unhealthy when a container health check reports unhealthy', async () => {
      dockerode.listContainers.mockResolvedValue([
        {
          Id: 'c1',
          Names: ['/test-app-db'],
          State: 'running',
          Status: 'Up 1 minute (unhealthy)',
        } as any,
      ]);

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue({
          State: {
            Status: 'running',
            Running: true,
            Health: {
              Status: 'unhealthy',
              FailingStreak: 5,
              Log: [{ Output: 'Connection refused' }],
            },
          },
        }),
      };
      dockerode.getContainer.mockReturnValue(mockContainer as any);

      const result = await service.verifyContainerHealthProbe(testUrn);

      expect(result.ok).toBe(false);
      expect(result.healthy).toBe(false);
      expect(result.containers[0].healthStatus).toBe('unhealthy');
      expect(result.message).toContain('Health probe failed');
    });

    it('considers containers without a health check healthy if they are running', async () => {
      dockerode.listContainers.mockResolvedValue([
        {
          Id: 'c2',
          Names: ['/test-app-worker'],
          State: 'running',
          Status: 'Up 30 seconds',
        } as any,
      ]);

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue({
          State: {
            Status: 'running',
            Running: true,
          },
        }),
      };
      dockerode.getContainer.mockReturnValue(mockContainer as any);

      const result = await service.verifyContainerHealthProbe(testUrn);

      expect(result.ok).toBe(true);
      expect(result.healthy).toBe(true);
      expect(result.containers[0].hasHealthCheck).toBe(false);
      expect(result.containers[0].state).toBe('running');
    });

    it('considers containers without a health check unhealthy if they are exited/stopped', async () => {
      dockerode.listContainers.mockResolvedValue([
        {
          Id: 'c3',
          Names: ['/test-app-crashed'],
          State: 'exited',
          Status: 'Exited (1) 5 seconds ago',
        } as any,
      ]);

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue({
          State: {
            Status: 'exited',
            Running: false,
          },
        }),
      };
      dockerode.getContainer.mockReturnValue(mockContainer as any);

      const result = await service.verifyContainerHealthProbe(testUrn);

      expect(result.ok).toBe(false);
      expect(result.healthy).toBe(false);
      expect(result.message).toContain('Health probe failed');
    });

    it('returns not ok when no containers exist for the app', async () => {
      dockerode.listContainers.mockResolvedValue([]);

      const result = await service.verifyContainerHealthProbe(testUrn);

      expect(result.ok).toBe(false);
      expect(result.healthy).toBe(false);
      expect(result.message).toContain('No containers found');
    });

    it('treats a one-shot init container that exited cleanly (code 0) as healthy, not crashed', async () => {
      dockerode.listContainers.mockResolvedValue([
        {
          Id: 'migrate',
          Names: ['/ci-memory_ci-marketplace-migrate-database-1'],
          State: 'exited',
          Status: 'Exited (0) 9 minutes ago',
        } as any,
        {
          Id: 'api',
          Names: ['/ci-memory_ci-marketplace-api-1'],
          State: 'running',
          Status: 'Up 9 minutes',
        } as any,
      ]);

      dockerode.getContainer.mockImplementation(
        (id: string) =>
          ({
            inspect: vi
              .fn()
              .mockResolvedValue(
                id === 'migrate' ? { State: { Status: 'exited', Running: false, ExitCode: 0 } } : { State: { Status: 'running', Running: true } },
              ),
          }) as any,
      );

      const result = await service.verifyContainerHealthProbe(testUrn);

      expect(result.ok).toBe(true);
      expect(result.healthy).toBe(true);
      expect(result.containers.find((c) => c.id === 'migrate')?.exitCode).toBe(0);
    });

    it('still flags a container that exited with a nonzero code as unhealthy', async () => {
      dockerode.listContainers.mockResolvedValue([
        {
          Id: 'c4',
          Names: ['/test-app-crashed'],
          State: 'exited',
          Status: 'Exited (1) 5 seconds ago',
        } as any,
      ]);

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue({
          State: {
            Status: 'exited',
            Running: false,
            ExitCode: 1,
          },
        }),
      };
      dockerode.getContainer.mockReturnValue(mockContainer as any);

      const result = await service.verifyContainerHealthProbe(testUrn);

      expect(result.ok).toBe(false);
      expect(result.healthy).toBe(false);
      expect(result.message).toContain('Health probe failed');
    });
  });
});
