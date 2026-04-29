import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AppConfigTools } from '../../tools/app-config.tools';
import { UserConfigService } from '@/modules/user-config/user-config.service';
import { AppsService } from '@/modules/apps/apps.service';

describe('AppConfigTools', () => {
  let tools: AppConfigTools;
  let userConfigService: MockProxy<UserConfigService>;
  let appsService: MockProxy<AppsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppConfigTools,
        { provide: UserConfigService, useValue: mock<UserConfigService>() },
        { provide: AppsService, useValue: mock<AppsService>() },
      ],
    }).compile();
    tools = module.get<AppConfigTools>(AppConfigTools);
    userConfigService = module.get(UserConfigService);
    appsService = module.get(AppsService);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_get_user_config', () => {
    it('should return dockerCompose, appEnv, and isEnabled', async () => {
      userConfigService.getUserConfig.mockResolvedValue({ dockerCompose: 'yaml', appEnv: 'KEY=val', isEnabled: true });
      const result = await tools.getUserConfig({ appUrn: 'ci-store:test' });
      expect(result.dockerCompose).toBe('yaml');
      expect(result.appEnv).toBe('KEY=val');
      expect(result.isEnabled).toBe(true);
    });
  });

  describe('hub_update_user_config', () => {
    it('should update user config files and return success', async () => {
      userConfigService.updateUserConfig.mockResolvedValue(undefined);
      const result = await tools.updateUserConfig({ appUrn: 'ci-store:test', dockerCompose: 'new-yaml', appEnv: 'NEW=val' });
      expect(userConfigService.updateUserConfig).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('hub_enable_user_config', () => {
    it('should enable user config for the specified app', async () => {
      userConfigService.enableUserConfig.mockResolvedValue(undefined);
      const result = await tools.enableUserConfig({ appUrn: 'ci-store:test' });
      expect(userConfigService.enableUserConfig).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('hub_disable_user_config', () => {
    it('should disable user config for the specified app', async () => {
      userConfigService.disableUserConfig.mockResolvedValue(undefined);
      const result = await tools.disableUserConfig({ appUrn: 'ci-store:test' });
      expect(userConfigService.disableUserConfig).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('hub_ignore_app_version', () => {
    it('should mark the app version as ignored', async () => {
      appsService.ignoreAppVersion.mockResolvedValue(undefined as any);
      await tools.ignoreAppVersion({ appUrn: 'ci-store:test' });
      expect(appsService.ignoreAppVersion).toHaveBeenCalled();
    });
  });

  describe('hub_unignore_app_version', () => {
    it('should unmark the app version as ignored', async () => {
      appsService.unignoreAppVersion.mockResolvedValue(undefined as any);
      await tools.unignoreAppVersion({ appUrn: 'ci-store:test' });
      expect(appsService.unignoreAppVersion).toHaveBeenCalled();
    });
  });
});
