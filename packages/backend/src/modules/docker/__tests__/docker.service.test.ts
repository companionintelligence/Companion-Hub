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

    configService.get.mockReturnValue({
      dataDir: '/data',
      appsDir: '/data/apps',
    } as any);

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

      // Mock spawn
      const mockSpawnProcess = new EventEmitter() as any;
      mockSpawnProcess.stdout = new EventEmitter();
      mockSpawnProcess.stderr = new EventEmitter();
      mockSpawnProcess.on = vi.fn().mockImplementation((event, handler) => {
        if (event === 'close') {
          // Simulate successful close
          setTimeout(() => handler(0), 10);
        }
        return mockSpawnProcess;
      });

      (child_process.spawn as any).mockReturnValue(mockSpawnProcess);

      await service.composeApp(appUrn, command);

      expect(child_process.spawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['compose', '--project-name', 'test-app', 'up', '-d']),
        expect.objectContaining({ cwd: '/apps/test-app' }),
      );
    });
  });
});
