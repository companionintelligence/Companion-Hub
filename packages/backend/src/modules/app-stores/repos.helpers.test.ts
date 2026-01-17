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
  global.fetch = fetchMock;

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

      await service.pullRepo('http://cloud.api', 'ci-cloud', 'ci_cloud_api');

      expect(fetchMock).toHaveBeenCalledWith('http://cloud.api/store');

      // Verify it creates directories and writes files
      expect(fs.promises.mkdir).toHaveBeenCalled();
      // We expect writes for each app's config.json
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('app1/config.json'), expect.stringContaining('"slug": "app1"'));
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

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-cloud', 'app1');

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://cloud.api/store/app1/install',
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-device-id': 'test-uuid' }),
        }),
      );
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('docker-compose.yml'), 'services: test');
    });

    it('should handle payment required', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 402,
        statusText: 'Payment Required',
        json: async () => ({ error: 'Payment Required' }),
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-cloud', 'paid-app');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Payment Required');
    });
  });
});
