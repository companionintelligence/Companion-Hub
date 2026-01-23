import { Test, TestingModule } from '@nestjs/testing';
import { UserConfigService } from '../user-config.service';
import { AppsRepository } from '../../apps/apps.repository';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppsService } from '../../apps/apps.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach } from 'vitest';
import { TranslatableError } from '@/common/error/translatable-error';

describe('UserConfigService', () => {
  let service: UserConfigService;
  let appFilesManager: MockProxy<AppFilesManager>;
  let appsRepository: MockProxy<AppsRepository>;
  let appsService: MockProxy<AppsService>;
  let filesystemService: MockProxy<FilesystemService>;

  beforeEach(async () => {
    appFilesManager = mock<AppFilesManager>();
    appsRepository = mock<AppsRepository>();
    appsService = mock<AppsService>();
    filesystemService = mock<FilesystemService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserConfigService,
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: AppsRepository, useValue: appsRepository },
        { provide: AppsService, useValue: appsService },
        { provide: FilesystemService, useValue: filesystemService },
      ],
    }).compile();

    service = module.get<UserConfigService>(UserConfigService);
  });

  describe('getUserConfig', () => {
    it('should return user config', async () => {
      appsService.getApp.mockResolvedValue({ app: { id: 'app' as any, userConfigEnabled: true } } as any);
      appFilesManager.getUserComposeFile.mockResolvedValue({ path: 'path', content: 'compose' });
      appFilesManager.getUserEnv.mockResolvedValue({ path: 'path', content: 'env' });

      const result = await service.getUserConfig('app' as any);
      expect(result).toEqual({
        dockerCompose: 'compose',
        appEnv: 'env',
        isEnabled: true,
      });
    });
  });

  describe('updateUserConfig', () => {
    it('should write config to files', async () => {
      appFilesManager.getUserComposeFile.mockResolvedValue({ path: 'compose-path', content: null });
      appFilesManager.getUserEnv.mockResolvedValue({ path: 'env-path', content: null });

      await service.updateUserConfig('app' as any, { dockerCompose: 'compose', appEnv: 'env' } as any);

      expect(filesystemService.writeTextFile).toHaveBeenCalledWith('compose-path', 'compose');
      expect(filesystemService.writeTextFile).toHaveBeenCalledWith('env-path', 'env');
    });
  });

  describe('enableUserConfig', () => {
    it('should enable user config', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1 } as any);

      await service.enableUserConfig('app' as any);

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { userConfigEnabled: true });
    });

    it('should throw if app not found', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      await expect(service.enableUserConfig('app' as any)).rejects.toThrow(TranslatableError);
    });
  });

  describe('disableUserConfig', () => {
    it('should disable user config', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1 } as any);

      await service.disableUserConfig('app' as any);

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { userConfigEnabled: false });
    });
  });
});
