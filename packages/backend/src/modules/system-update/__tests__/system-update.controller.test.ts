import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { SystemUpdateController } from '../system-update.controller';
import { SystemUpdateService } from '../system-update.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('SystemUpdateController', () => {
  let controller: SystemUpdateController;
  let updateService: MockProxy<SystemUpdateService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SystemUpdateController],
      providers: [
        { provide: SystemUpdateService, useValue: mock<SystemUpdateService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    controller = moduleRef.get(SystemUpdateController);
    updateService = moduleRef.get(SystemUpdateService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('checkForUpdates', () => {
    it('should return update check result', async () => {
      const updateInfo = { available: true, current: '1.0.0', latest: '1.1.0' };
      updateService.checkForUpdates.mockResolvedValue(updateInfo as any);

      const result = await controller.checkForUpdates();
      expect(result).toEqual(updateInfo);
    });
  });

  describe('performUpdate', () => {
    it('should perform update without target version', async () => {
      updateService.performUpdate.mockResolvedValue({ success: true } as any);

      const result = await controller.performUpdate();
      expect(result).toEqual({ success: true });
      expect(updateService.performUpdate).toHaveBeenCalledWith(undefined);
    });

    it('should perform update with target version', async () => {
      updateService.performUpdate.mockResolvedValue({ success: true } as any);

      const result = await controller.performUpdate({ targetVersion: '1.1.0' });
      expect(result).toEqual({ success: true });
      expect(updateService.performUpdate).toHaveBeenCalledWith('1.1.0');
    });
  });

  describe('auto-updates', () => {
    it('should get auto-updates status', () => {
      updateService.getAutoUpdatesEnabled.mockReturnValue(true);

      const result = controller.getAutoUpdates();
      expect(result).toEqual({ enabled: true });
    });

    it('should set auto-updates', async () => {
      updateService.setAutoUpdatesEnabled.mockResolvedValue(undefined);

      const result = await controller.setAutoUpdates({ enabled: false });
      expect(result).toEqual({ enabled: false });
      expect(updateService.setAutoUpdatesEnabled).toHaveBeenCalledWith(false);
    });
  });

  describe('getHostListenerStatus', () => {
    it('returns whether the desktop listener is reachable', async () => {
      updateService.getHostListenerStatus.mockResolvedValue({ reachable: false });

      await expect(controller.getHostListenerStatus()).resolves.toEqual({ reachable: false });
    });
  });

  describe('getHostListenerToken', () => {
    it('should return token when listener is available', () => {
      updateService.getHostUpdateListenerToken.mockReturnValue('secret-token');

      const result = controller.getHostListenerToken();
      expect(result).toEqual({ token: 'secret-token' });
    });

    it('should throw when listener token is unavailable', () => {
      updateService.getHostUpdateListenerToken.mockReturnValue(null);

      expect(() => controller.getHostListenerToken()).toThrow('Host update listener not available');
    });
  });
});
