import { Test, TestingModule } from '@nestjs/testing';
import { DockerService } from '../docker.service';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppsService } from '../../apps/apps.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import * as child_process from 'node:child_process';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

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

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    configService = mock<ConfigurationService>();
    filesystemService = mock<FilesystemService>();
    appFilesManager = mock<AppFilesManager>();
    appsService = mock<AppsService>();

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
        [
          'compose',
          '--env-file',
          '/data/.env',
          '--project-name',
          'ci-hub',
          '-f',
          '/data/docker-compose.yml',
          'logs',
          '--follow',
          '-n',
          '300',
          'ci-os-hub',
        ],
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
        ['--env-file', '/data/.env', '--project-name', 'ci-hub', '-f', '/data/docker-compose.yml', 'logs', '--follow', '-n', '300', 'ci-os-hub'],
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
        ['compose', '--env-file', '/data/.env', '--project-name', 'ci-hub', '-f', '/data/docker-compose.yml', 'logs', '--no-color', 'ci-os-hub'],
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
        ['--env-file', '/data/.env', '--project-name', 'ci-hub', '-f', '/data/docker-compose.yml', 'logs', '--no-color', 'ci-os-hub'],
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
        [
          'compose',
          '--env-file',
          '/data/.env',
          '--project-name',
          'ci-hub-log-download',
          '-f',
          '/data/docker-compose.yml',
          'logs',
          '--no-color',
          'ci-os-hub',
        ],
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
        composeFile: '/data/docker-compose.yml',
        profile: 'cloudflare',
      });

      expect(child_process.spawn).toHaveBeenCalledWith(
        'docker',
        ['compose', '--env-file', '/data/.env', '-f', '/data/docker-compose.yml', '--profile', 'cloudflare', 'up', 'cloudflared', '-d', '--no-build'],
        expect.objectContaining({
          cwd: '/data',
          env: expect.objectContaining({
            ENV_FILE: '/data/.env',
            UNRELATED_VAR: 'still-here',
          }),
        }),
      );
    });

    it('should leave source compose paths unchanged outside the mounted runtime hub compose file', async () => {
      process.env.ENV_FILE = '.env.dev';
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
        composeFile: '/app/docker-compose.local.yml',
        profile: 'cloudflare',
      });

      expect(child_process.spawn).toHaveBeenCalledWith(
        'docker',
        ['compose', '-f', '/app/docker-compose.local.yml', '--profile', 'cloudflare', 'up', 'cloudflared', '-d', '--no-build'],
        { cwd: '/app' },
      );
    });
  });
});
