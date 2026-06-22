import { Test } from '@nestjs/testing';
import { ReposHelpers } from './repos.helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { RegistrationService } from '../registration/registration.service';
import axios from 'axios';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import fs from 'node:fs';
import path from 'node:path';

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

vi.mock('axios');

describe('ReposHelpers', () => {
  let service: ReposHelpers;
  let configService = mock<ConfigurationService>();
  let filesystemService = mock<FilesystemService>();
  const logger = mockDeep<LoggerService>();
  let registrationService = mock<RegistrationService>();

  const axiosMock = vi.mocked(axios);

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

      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: appsData,
      });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(axiosMock.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: 'http://cloud.api/store' }));

      // Verify it creates directories and writes files
      expect(fs.promises.mkdir).toHaveBeenCalled();
      // We expect writes for each app's config.json
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.normalize('app1/config.json')),
        expect.stringContaining('"slug": "app1"'),
      );
    });

    it('should enrich missing metadata for CI Cloud apps', async () => {
      const minimalApp = {
        id: 'app1',
        slug: 'app1',
        name: 'App 1',
        // Missing author, urn, etc.
      };

      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: [minimalApp],
      });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(axiosMock.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: 'http://cloud.api/store' }));

      const calls = (fs.promises.writeFile as any).mock.calls;
      const configCall = calls.find((call: any[]) => call[0].includes(path.normalize('app1/config.json')));
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

    it('uses metadata/description.md for the full app description', async () => {
      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: [{ id: 'app1', slug: 'app1', name: 'App 1', description: 'Config fallback description' }],
      });

      axiosMock.get.mockImplementation(async (url: string) => {
        if (url === 'http://cloud.api/store/app1/metadata/description.md') {
          return {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/markdown; charset=utf-8' },
            data: '# Markdown description',
          };
        }

        return {
          status: 404,
          statusText: 'Not Found',
          headers: {},
          data: '',
        };
      });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      const calls = (fs.promises.writeFile as any).mock.calls;
      const descriptionCall = calls.find((call: any[]) => call[0].includes(path.normalize('app1/metadata/description.md')));
      const configCall = calls.find((call: any[]) => call[0].includes(path.normalize('app1/config.json')));

      expect(descriptionCall).toBeDefined();
      expect(descriptionCall[1]).toBe('# Markdown description');
      expect(JSON.parse(configCall[1]).description).toBe('# Markdown description');
    });

    it('falls back to config description for unsupported description content-types', async () => {
      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: [{ id: 'app1', slug: 'app1', name: 'App 1', description: 'Config fallback description' }],
      });

      axiosMock.get.mockImplementation(async (url: string) => {
        if (url === 'http://cloud.api/store/app1/metadata/description.md') {
          return {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/html; charset=utf-8' },
            data: '<html>wrong payload</html>',
          };
        }

        return {
          status: 404,
          statusText: 'Not Found',
          headers: {},
          data: '',
        };
      });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      const calls = (fs.promises.writeFile as any).mock.calls;
      const descriptionCall = calls.find((call: any[]) => call[0].includes(path.normalize('app1/metadata/description.md')));
      const configCall = calls.find((call: any[]) => call[0].includes(path.normalize('app1/config.json')));

      expect(descriptionCall).toBeUndefined();
      expect(JSON.parse(configCall[1]).description).toBe('Config fallback description');
    });

    it('retries transient CI Cloud HTTP failures before succeeding', async () => {
      axiosMock.request
        .mockResolvedValueOnce({ status: 503, statusText: 'Service Unavailable', data: {} })
        .mockResolvedValueOnce({ status: 200, statusText: 'OK', data: [] });

      const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(result.success).toBe(true);
      expect(axiosMock.request).toHaveBeenCalledTimes(2);
    });

    it('does not retry permanent CI Cloud client errors', async () => {
      axiosMock.request.mockResolvedValueOnce({ status: 404, statusText: 'Not Found', data: {} });

      const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(result.success).toBe(false);
      expect(result.message).toContain('404 Not Found');
      expect(axiosMock.request).toHaveBeenCalledTimes(1);
    });
  });

  describe('downloadAppFiles', () => {
    it('should fetch install files and write them', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          files: {
            'docker-compose.yml': 'services: test',
          },
        },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'app1');

      expect(result.success).toBe(true);
      expect(axiosMock.get).toHaveBeenCalledWith(
        'http://cloud.api/store/app1/install',
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-device-id': 'test-uuid' }),
        }),
      );
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('docker-compose.yml'), 'services: test');
    });

    it('should write multiple files from files format', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          files: {
            'config.json': '{"name":"test"}',
            'docker-compose.json': 'services:\n  app:\n    image: test',
          },
        },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'multi-app');

      expect(result.success).toBe(true);
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('config.json'), '{"name":"test"}');
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('docker-compose.json'), 'services:\n  app:\n    image: test');
    });

    it('should handle canonical files format with multiple files', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          files: {
            'docker-compose.yml': 'services:\n  app:\n    image: nginx',
            'config.json': '{"name":"multi"}',
            'data/settings.json': '{"key":"value"}',
          },
        },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'multi-file-app');

      expect(result.success).toBe(true);
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(3);
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.normalize('multi-file-app/docker-compose.yml')),
        'services:\n  app:\n    image: nginx',
      );
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining(path.normalize('multi-file-app/config.json')), '{"name":"multi"}');
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.normalize('multi-file-app/data/settings.json')),
        '{"key":"value"}',
      );

      // Verify mkdir is called for nested paths (data/ subdirectory)
      const mkdirCalls = (fs.promises.mkdir as any).mock.calls.map((c: any[]) => c[0]);
      expect(mkdirCalls).toContainEqual(expect.stringContaining(path.normalize('multi-file-app/data')));
    });

    it('should reject responses that do not contain a files object', async () => {
      axiosMock.get.mockResolvedValue({
        status: 500,
        statusText: 'Internal Server Error',
        data: {},
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'bad-app');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to fetch app files');
    });

    it('should handle empty files object gracefully', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { files: {} },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'empty-app');

      expect(result.success).toBe(true);
      // No writeFile calls for app content (only mkdir/chmod for dir setup)
      const writeFileCalls = (fs.promises.writeFile as any).mock.calls;
      expect(writeFileCalls.length).toBe(0);
    });

    it('should handle response with no files property (warn, not crash)', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { someOtherData: 'hello' },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'no-files-app');

      expect(result.success).toBe(true);
      expect(result.message).toBe('App files downloaded');
      // Should log warning but not write any files
      const writeFileCalls = (fs.promises.writeFile as any).mock.calls;
      expect(writeFileCalls.length).toBe(0);
    });

    it('MUST NOT support legacy {config, dockerCompose} format', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          config: '{"name":"legacy"}',
          dockerCompose: 'services:\n  app:\n    image: old',
        },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'legacy-app');

      // Should succeed but write no files (legacy format not recognized)
      expect(result.success).toBe(true);
      const writeFileCalls = (fs.promises.writeFile as any).mock.calls;
      expect(writeFileCalls.length).toBe(0);
    });

    it('should pass through file content exactly as received (no transformation)', async () => {
      const exactContent = '  spaces  \n\ttabs\t\n{"json": true}\nspecial chars: àéîõü™©®';
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          files: { 'exact.txt': exactContent },
        },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'exact-app');

      expect(result.success).toBe(true);
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining(path.normalize('exact-app/exact.txt')), exactContent);
    });

    it('should create directories before writing files', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          files: { 'test.yml': 'content' },
        },
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
      axiosMock.get.mockResolvedValue({
        status: 402,
        statusText: 'Payment Required',
        data: { error: 'Payment Required' },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'paid-app');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Payment Required');
    });
  });
});
