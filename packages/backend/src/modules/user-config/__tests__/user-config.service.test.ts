import { Test, TestingModule } from '@nestjs/testing';
import { UserConfigService } from '../user-config.service';
import { AppsRepository } from '../../apps/apps.repository';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppsReadService } from '../../apps/apps-read.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach } from 'vitest';
import { TranslatableError } from '@/common/error/translatable-error';

describe('UserConfigService', () => {
  let service: UserConfigService;
  let appFilesManager: MockProxy<AppFilesManager>;
  let appsRepository: MockProxy<AppsRepository>;
  let appsReadService: MockProxy<AppsReadService>;
  let filesystemService: MockProxy<FilesystemService>;

  beforeEach(async () => {
    appFilesManager = mock<AppFilesManager>();
    appsRepository = mock<AppsRepository>();
    appsReadService = mock<AppsReadService>();
    filesystemService = mock<FilesystemService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserConfigService,
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: AppsRepository, useValue: appsRepository },
        { provide: AppsReadService, useValue: appsReadService },
        { provide: FilesystemService, useValue: filesystemService },
      ],
    }).compile();

    service = module.get<UserConfigService>(UserConfigService);
  });

  describe('getUserConfig', () => {
    it('should return user config', async () => {
      appsReadService.getApp.mockResolvedValue({ app: { id: 'app' as any, userConfigEnabled: true } } as any);
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
    const OVERRIDE = 'services:\n  web:\n    environment:\n      FOO: bar\n';

    beforeEach(() => {
      appsRepository.getApps.mockResolvedValue([] as any);
      appFilesManager.getUserComposeFile.mockResolvedValue({ path: 'compose-path', content: null });
      appFilesManager.getUserEnv.mockResolvedValue({ path: 'env-path', content: null });
      appFilesManager.getDockerComposeYaml.mockResolvedValue({ path: 'app-compose-path', content: null });
    });

    it('should write config to files', async () => {
      await service.updateUserConfig('app:store' as any, { dockerCompose: OVERRIDE, appEnv: 'FOO=bar' });

      expect(filesystemService.writeTextFile).toHaveBeenCalledWith('compose-path', OVERRIDE);
      expect(filesystemService.writeTextFile).toHaveBeenCalledWith('env-path', 'FOO=bar');
    });

    it('clears an override saved as empty', async () => {
      await service.updateUserConfig('app:store' as any, { dockerCompose: '', appEnv: '' });

      expect(filesystemService.writeTextFile).toHaveBeenCalledWith('compose-path', '');
    });

    it('refuses an override the sandbox does not allow, names the rule and writes nothing', async () => {
      await expect(
        service.updateUserConfig('app:store' as any, { dockerCompose: 'services:\n  web:\n    not_a_known_key: 1\n', appEnv: '' }),
      ).rejects.toMatchObject({
        response: { message: 'COMPOSE_OVERRIDE_NOT_ALLOWED', intlParams: { details: expect.stringContaining('services.web.not_a_known_key') } },
        status: 400,
      });

      expect(filesystemService.writeTextFile).not.toHaveBeenCalled();
    });

    // Compose merges the override's labels onto the Hub's, so the Hub's routers count for it.
    it('judges traefik.enable with the routers the Hub’s compose gives the service', async () => {
      const enable = 'services:\n  web:\n    labels:\n      traefik.enable: "true"\n';
      await expect(service.updateUserConfig('app:store' as any, { dockerCompose: enable, appEnv: '' })).rejects.toMatchObject({
        response: { intlParams: { details: expect.stringContaining('CUSTOM_APP_ERROR_TRAEFIK_ENABLE_WITHOUT_ROUTER') } },
      });

      appFilesManager.getDockerComposeYaml.mockResolvedValue({
        path: 'app-compose-path',
        content: 'services:\n  web:\n    labels:\n      traefik.http.routers.app-store-api.rule: Host(`${APP_DOMAIN}`) && PathPrefix(`/api`)\n',
      });
      await service.updateUserConfig('app:store' as any, { dockerCompose: enable, appEnv: '' });
      expect(filesystemService.writeTextFile).toHaveBeenCalledWith('compose-path', enable);
    });

    it('refuses an override that cannot be read', async () => {
      await expect(service.updateUserConfig('app:store' as any, { dockerCompose: 'services:\n  web: [', appEnv: '' })).rejects.toBeInstanceOf(
        TranslatableError,
      );

      expect(filesystemService.writeTextFile).not.toHaveBeenCalled();
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
