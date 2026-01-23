import { Test, TestingModule } from '@nestjs/testing';
import { CustomAppService } from '../custom-apps.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('CustomAppService', () => {
  let service: CustomAppService;
  let filesystem: MockProxy<FilesystemService>;
  let configService: MockProxy<ConfigurationService>;
  let appsRepository: MockProxy<AppsRepository>;
  let logger: MockProxy<LoggerService>;

  beforeEach(async () => {
    filesystem = mock<FilesystemService>();
    configService = mock<ConfigurationService>();
    appsRepository = mock<AppsRepository>();
    logger = mock<LoggerService>();

    configService.get.mockImplementation((key) => {
      if (key === 'directories') return { dataDir: '/data' } as any;
      if (key === 'demoMode') return false;
      return null;
    });

    filesystem.createDirectory.mockResolvedValue(true);
    filesystem.createDirectories.mockResolvedValue(true);
    filesystem.writeJsonFile.mockResolvedValue(true);
    filesystem.writeTextFile.mockResolvedValue(true);
    filesystem.writeBinaryFile.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomAppService,
        { provide: FilesystemService, useValue: filesystem },
        { provide: ConfigurationService, useValue: configService },
        { provide: AppsRepository, useValue: appsRepository },
        { provide: LoggerService, useValue: logger },
      ],
    }).compile();

    service = module.get<CustomAppService>(CustomAppService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createCustomApp', () => {
    it('should create app when valid', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);

      const config = {
        version: '3',
        services: [{ name: 'web', image: 'nginx', isMain: true }],
      };

      const result = await service.createCustomApp({ name: 'myapp', config: config as any });

      expect(result.appUrn).toBe('myapp:_user' as any as any);
      expect(filesystem.createDirectories).toHaveBeenCalled();
      expect(filesystem.writeTextFile).toHaveBeenCalledWith(
        expect.stringContaining('docker-compose.json'),
        expect.stringContaining('"version": "3"'),
      );
      expect(appsRepository.createApp).toHaveBeenCalled();
    });

    it('should throw if duplicate', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1 } as any);
      await expect(service.createCustomApp({ name: 'myapp', config: '' as any as any })).rejects.toThrow('CUSTOM_APP_ERROR_DUPLICATE_NAME');
    });
  });

  describe('uploadAppImage', () => {
    it('should upload image', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1 } as any);
      await service.uploadAppImage('myapp:_user' as any as any, Buffer.from('test'));

      expect(filesystem.writeBinaryFile).toHaveBeenCalled();
    });

    it('should throw if not custom app', async () => {
      await expect(service.uploadAppImage('app:store' as any as any, Buffer.from('test'))).rejects.toThrow('CUSTOM_APP_ERROR_NOT_CUSTOM');
    });
  });
});
