import { Test } from '@nestjs/testing';
import { ReposHelpers } from './repos.helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { RegistrationService } from '../registration/registration.service';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import fs from 'node:fs';

// Mock fs module
vi.mock('node:fs', async () => {
  return {
    default: {
      promises: {
        mkdir: vi.fn(),
        chmod: vi.fn(),
        writeFile: vi.fn(),
        rm: vi.fn(),
        readFile: vi.fn().mockResolvedValue(''),
      },
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(),
      rmdirSync: vi.fn(),
      renameSync: vi.fn(),
      statSync: vi.fn(),
    },
  };
});

// Mock child_process
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('ReposHelpers', () => {
  let service: ReposHelpers;
  let configService = mock<ConfigurationService>();
  let filesystemService = mock<FilesystemService>();
  const logger = mockDeep<LoggerService>();
  let registrationService = mock<RegistrationService>();

  // Mock fetch
  const fetchMock = vi.fn();
  global.fetch = fetchMock as any;

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    // @ts-expect-error
    configService.get.mockReturnValue({ dataDir: '/tmp/data' });
    // @ts-expect-error
    configService.getConfig.mockReturnValue({ domain: 'local.test' });

    filesystemService = mock<FilesystemService>();
    filesystemService.pathExists.mockResolvedValue(false);
    filesystemService.removeDirectory.mockResolvedValue(true);

    registrationService = mock<RegistrationService>();
    registrationService.getDeviceId.mockResolvedValue('test-uuid');

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReposHelpers,
        { provide: ConfigurationService, useValue: configService },
        { provide: FilesystemService, useValue: filesystemService },
        { provide: LoggerService, useValue: logger },
        { provide: RegistrationService, useValue: registrationService },
      ],
    }).compile();

    service = moduleRef.get<ReposHelpers>(ReposHelpers);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('pullRepo with ci_cloud_api', () => {
    it('should fetch apps metadata and write config.json', async () => {
      const appsData = [
        { slug: 'app1', name: 'App 1', version: '1.0.0' },
        { slug: 'app2', name: 'App 2', version: '1.0.0' },
      ];

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => appsData,
      });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(fetchMock).toHaveBeenCalledWith('http://cloud.api/store');

      // Verify it creates directories and writes files
      expect(fs.promises.mkdir).toHaveBeenCalled();
      // We expect writes for each app's config.json
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('app1/config.json'), expect.stringContaining('"slug": "app1"'));
    });

    it('should enrich missing metadata for CI Cloud apps', async () => {
      const minimalApp = {
        id: 'app1',
        slug: 'app1',
        name: 'App 1',
        // Missing author, urn, etc.
      };

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => [minimalApp],
      });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(fetchMock).toHaveBeenCalledWith('http://cloud.api/store');

      const calls = (fs.promises.writeFile as any).mock.calls;
      const configCall = calls.find((call: any[]) => call[0].includes('app1/config.json'));
      expect(configCall).toBeDefined();

      const writtenConfig = JSON.parse(configCall[1]);

      // Check enriched fields
      expect(writtenConfig).toHaveProperty('urn', 'urn:app:app1');
      expect(writtenConfig).toHaveProperty('author', 'Unknown Author');
      expect(writtenConfig).toHaveProperty('available', true);
      expect(writtenConfig).toHaveProperty('categories', ['utilities']);
      expect(writtenConfig).toHaveProperty('port', 8080);
      expect(writtenConfig).toHaveProperty('supported_architectures', ['amd64', 'arm64']);
    });
  });

  describe('downloadAppFiles', () => {
    it('should fetch install files and write them', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          files: {
            'docker-compose.yml': 'services: test',
          },
        }),
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'app1');

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://cloud.api/store/app1/install',
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-device-id': 'test-uuid' }),
        }),
      );
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('docker-compose.yml'), 'services: test');
    });

    it('should write multiple files from files format', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          files: {
            'config.json': '{"name":"test"}',
            'docker-compose.json': 'services:\n  app:\n    image: test',
          },
        }),
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'multi-app');

      expect(result.success).toBe(true);
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('config.json'), '{"name":"test"}');
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('docker-compose.json'), 'services:\n  app:\n    image: test');
    });

    it('should handle canonical files format with multiple files', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          files: {
            'docker-compose.yml': 'services:\n  app:\n    image: nginx',
            'config.json': '{"name":"multi"}',
            'data/settings.json': '{"key":"value"}',
          },
        }),
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'multi-file-app');

      expect(result.success).toBe(true);
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(3);
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('multi-file-app/docker-compose.yml'),
        'services:\n  app:\n    image: nginx',
      );
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('multi-file-app/config.json'), '{"name":"multi"}');
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('multi-file-app/data/settings.json'), '{"key":"value"}');
    });

    it('should reject responses that do not contain a files object', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({}),
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'bad-app');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to fetch app files');
    });

    it('should handle empty files object gracefully', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ files: {} }),
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'empty-app');

      expect(result.success).toBe(true);
      // No writeFile calls for app content (only mkdir/chmod for dir setup)
      const writeFileCalls = (fs.promises.writeFile as any).mock.calls;
      expect(writeFileCalls.length).toBe(0);
    });

    it('should handle response with no files property (warn, not crash)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ someOtherData: 'hello' }),
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'no-files-app');

      expect(result.success).toBe(true);
      expect(result.message).toBe('App files downloaded');
      // Should log warning but not write any files
      const writeFileCalls = (fs.promises.writeFile as any).mock.calls;
      expect(writeFileCalls.length).toBe(0);
    });

    it('MUST NOT support legacy {config, dockerCompose} format', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          config: '{"name":"legacy"}',
          dockerCompose: 'services:\n  app:\n    image: old',
        }),
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'legacy-app');

      // Should succeed but write no files (legacy format not recognized)
      expect(result.success).toBe(true);
      const writeFileCalls = (fs.promises.writeFile as any).mock.calls;
      expect(writeFileCalls.length).toBe(0);
    });

    it('should pass through file content exactly as received (no transformation)', async () => {
      const exactContent = '  spaces  \n\ttabs\t\n{"json": true}\nspecial chars: àéîõü™©®';
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          files: { 'exact.txt': exactContent },
        }),
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'exact-app');

      expect(result.success).toBe(true);
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('exact-app/exact.txt'), exactContent);
    });

    it('should create directories before writing files', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          files: { 'test.yml': 'content' },
        }),
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'dir-app');

      expect(result.success).toBe(true);
      // mkdir should be called before writeFile (ensureDirectoryWithPermissions)
      expect(fs.promises.mkdir).toHaveBeenCalled();
      expect(fs.promises.writeFile).toHaveBeenCalled();

      // Verify mkdir was called before writeFile
      const mkdirOrder = (fs.promises.mkdir as any).mock.invocationCallOrder[0];
      const writeFileOrder = (fs.promises.writeFile as any).mock.invocationCallOrder[0];
      expect(mkdirOrder).toBeLessThan(writeFileOrder);
    });

    it('should handle payment required', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 402,
        statusText: 'Payment Required',
        json: async () => ({ error: 'Payment Required' }),
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'paid-app');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Payment Required');
    });
  });
});
