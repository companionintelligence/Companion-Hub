import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { UserConfigController } from '../user-config.controller';
import { UserConfigService } from '../user-config.service';

describe('UserConfigController', () => {
  let controller: UserConfigController;
  let userConfigService: MockProxy<UserConfigService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UserConfigController],
      providers: [{ provide: UserConfigService, useValue: mock<UserConfigService>() }],
    }).compile();

    controller = moduleRef.get(UserConfigController);
    userConfigService = moduleRef.get(UserConfigService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getUserConfig', () => {
    it('should return user config for an app', async () => {
      const config = { exposed: false, domain: null, openPort: null };
      userConfigService.getUserConfig.mockResolvedValue(config as any);

      const result = await controller.getUserConfig('my-app:my-store');
      expect(result).toBeDefined();
      expect(userConfigService.getUserConfig).toHaveBeenCalled();
    });
  });

  describe('updateUserConfig', () => {
    it('should update user config', async () => {
      userConfigService.updateUserConfig.mockResolvedValue(undefined);

      await controller.updateUserConfig('my-app:my-store', { exposed: true } as any);
      expect(userConfigService.updateUserConfig).toHaveBeenCalled();
    });
  });

  describe('enableUserConfig', () => {
    it('should enable user config', async () => {
      userConfigService.enableUserConfig.mockResolvedValue(undefined as any);

      await controller.enableUserConfig('my-app:my-store');
      expect(userConfigService.enableUserConfig).toHaveBeenCalled();
    });
  });

  describe('disableUserConfig', () => {
    it('should disable user config', async () => {
      userConfigService.disableUserConfig.mockResolvedValue(undefined as any);

      await controller.disableUserConfig('my-app:my-store');
      expect(userConfigService.disableUserConfig).toHaveBeenCalled();
    });
  });
});
