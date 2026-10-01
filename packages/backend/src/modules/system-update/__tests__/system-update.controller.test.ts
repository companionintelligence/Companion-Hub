import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AuthGuard } from '../../auth/auth.guard';
import { DesktopReleaseService } from '../desktop-release.service';
import { SystemUpdateController } from '../system-update.controller';
import { SystemUpdateService } from '../system-update.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('SystemUpdateController', () => {
  let controller: SystemUpdateController;
  let updateService: MockProxy<SystemUpdateService>;
  let desktopReleaseService: MockProxy<DesktopReleaseService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SystemUpdateController],
      providers: [
        { provide: SystemUpdateService, useValue: mock<SystemUpdateService>() },
        { provide: DesktopReleaseService, useValue: mock<DesktopReleaseService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    controller = moduleRef.get(SystemUpdateController);
    updateService = moduleRef.get(SystemUpdateService);
    desktopReleaseService = moduleRef.get(DesktopReleaseService);
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

    it.each(['1.1.0\nCI_HUB_CLOUD_URL_OVERRIDE=https://attacker.example', 'latest', '', 42])(
      'refuses target version %j without starting an update',
      async (targetVersion) => {
        await expect(controller.performUpdate({ targetVersion: targetVersion as string })).rejects.toThrow(BadRequestException);
        expect(updateService.performUpdate).not.toHaveBeenCalled();
      },
    );
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

  describe('getDesktopRelease', () => {
    it('answers with the release read for the page environment, platform, and architecture', async () => {
      const release = { latestVersion: '0.2.77', downloadUrl: 'https://dl.ci.computer/v0.2.77/linux/deb/x64/Companion%20Hub_0.2.77_amd64.deb' };
      desktopReleaseService.getDesktopRelease.mockResolvedValue(release);

      await expect(controller.getDesktopRelease({ environment: 'production', platform: 'linux', arch: 'x86_64' })).resolves.toEqual(release);
      expect(desktopReleaseService.getDesktopRelease).toHaveBeenCalledWith({ environment: 'production', platform: 'linux', arch: 'x86_64' });
    });

    it('is only for a signed-in user', () => {
      // An unguarded route reads back `undefined`; default to [] so the assertion cannot pass on it.
      const guards = (Reflect.getMetadata('__guards__', SystemUpdateController.prototype.getDesktopRelease) ?? []) as unknown[];

      expect(guards).toContain(AuthGuard);
    });
  });
});
