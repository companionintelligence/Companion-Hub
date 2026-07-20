import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock, mockDeep, type DeepMockProxy, type MockProxy } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { DockerService } from '@/modules/docker/docker.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import type { AppUrn } from '@ci-hub/common/types';
import { UninstallAppCommand } from '../uninstall-app-command';

describe('UninstallAppCommand', () => {
  const appUrn = 'test-app:store' as AppUrn;

  let command: UninstallAppCommand;
  let logger: DeepMockProxy<LoggerService>;
  let dockerService: {
    composeApp: ReturnType<typeof vi.fn>;
    snapshotAppImageIds: ReturnType<typeof vi.fn>;
    removeAppImages: ReturnType<typeof vi.fn>;
    removeAppNetworks: ReturnType<typeof vi.fn>;
  };
  let appFilesManager: MockProxy<AppFilesManager>;
  let portManager: MockProxy<PortManagerService>;

  beforeEach(() => {
    logger = mockDeep<LoggerService>();
    appFilesManager = mock<AppFilesManager>();
    appFilesManager.deleteAppFolder.mockResolvedValue(true);
    appFilesManager.deleteAppDataDir.mockResolvedValue(true);

    portManager = mock<PortManagerService>();
    portManager.releaseAll.mockResolvedValue(1);

    dockerService = {
      composeApp: vi.fn().mockResolvedValue({ success: true }),
      snapshotAppImageIds: vi.fn().mockResolvedValue(['sha256:a']),
      removeAppImages: vi.fn().mockResolvedValue(undefined),
      removeAppNetworks: vi.fn().mockResolvedValue(undefined),
    };

    const moduleRef = {
      get: vi.fn((token: unknown) => {
        if (token === LoggerService) return logger;
        if (token === AppFilesManager) return appFilesManager;
        if (token === DockerService) return dockerService;
        if (token === PortManagerService) return portManager;
        return null;
      }),
    } as unknown as ModuleRef;

    const dockerode = mock<Dockerode>();
    command = new UninstallAppCommand(moduleRef, dockerode);
  });

  it('runs compose down with --rmi all and explicit image/network cleanup', async () => {
    const result = await command.execute(appUrn);

    expect(result).toEqual({ success: true, message: `App ${appUrn} uninstalled successfully` });
    expect(dockerService.snapshotAppImageIds).toHaveBeenCalledWith(appUrn);
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'down --remove-orphans -v --rmi all');
    expect(dockerService.removeAppImages).toHaveBeenCalledWith(appUrn, ['sha256:a']);
    expect(dockerService.removeAppNetworks).toHaveBeenCalledWith(appUrn);
    expect(appFilesManager.deleteAppFolder).toHaveBeenCalledWith(appUrn);
    expect(appFilesManager.deleteAppDataDir).toHaveBeenCalledWith(appUrn);

    const snapshotOrder = dockerService.snapshotAppImageIds.mock.invocationCallOrder[0];
    const downOrder = dockerService.composeApp.mock.invocationCallOrder[0];
    const removeImagesOrder = dockerService.removeAppImages.mock.invocationCallOrder[0];
    const removeNetworksOrder = dockerService.removeAppNetworks.mock.invocationCallOrder[0];
    const deleteFolderOrder = appFilesManager.deleteAppFolder.mock.invocationCallOrder[0];

    expect(snapshotOrder).toBeLessThan(downOrder);
    expect(downOrder).toBeLessThan(removeImagesOrder);
    expect(removeImagesOrder).toBeLessThan(removeNetworksOrder);
    expect(removeNetworksOrder).toBeLessThan(deleteFolderOrder);
  });

  it('preserves Docker volumes when deleteAllData is false', async () => {
    const moduleRef = {
      get: vi.fn((token: unknown) => {
        if (token === LoggerService) return logger;
        if (token === AppFilesManager) return appFilesManager;
        if (token === DockerService) return dockerService;
        if (token === PortManagerService) return portManager;
        return null;
      }),
    } as unknown as ModuleRef;

    const dockerode = mock<Dockerode>();
    const preserveDataCommand = new UninstallAppCommand(moduleRef, dockerode, false);

    const result = await preserveDataCommand.execute(appUrn);

    expect(result).toEqual({ success: true, message: `App ${appUrn} uninstalled successfully` });
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'down --remove-orphans --rmi all');
    expect(appFilesManager.deleteAppFolder).toHaveBeenCalledWith(appUrn);
    expect(appFilesManager.deleteAppDataDir).not.toHaveBeenCalled();
  });

  it('reports the remnant when app-data deletion partially fails (#907)', async () => {
    appFilesManager.deleteAppDataDir.mockResolvedValue(false);

    const result = await command.execute(appUrn);

    expect(result).toEqual({
      success: true,
      message: `App ${appUrn} uninstalled, but its app data could not be fully removed and may leave a remnant on disk.`,
      warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not be fully removed'));
  });

  it('reports the remnant when the app folder deletion fails (#907)', async () => {
    appFilesManager.deleteAppFolder.mockResolvedValue(false);

    const result = await command.execute(appUrn);

    expect(result).toEqual({
      success: true,
      message: `App ${appUrn} uninstalled, but its app folder could not be fully removed and may leave a remnant on disk.`,
      warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
    });
  });

  it('lists both remnants when the app folder AND app data deletion fail (#907)', async () => {
    appFilesManager.deleteAppFolder.mockResolvedValue(false);
    appFilesManager.deleteAppDataDir.mockResolvedValue(false);

    const result = await command.execute(appUrn);

    expect(result).toEqual({
      success: true,
      message: `App ${appUrn} uninstalled, but its app folder and app data could not be fully removed and may leave a remnant on disk.`,
      warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
    });
  });

  it('does not flag app data as a remnant when data deletion is skipped (deleteAllData=false)', async () => {
    appFilesManager.deleteAppDataDir.mockResolvedValue(false); // would-be failure, but never called

    const moduleRef = {
      get: vi.fn((token: unknown) => {
        if (token === LoggerService) return logger;
        if (token === AppFilesManager) return appFilesManager;
        if (token === DockerService) return dockerService;
        if (token === PortManagerService) return portManager;
        return null;
      }),
    } as unknown as ModuleRef;
    const preserveDataCommand = new UninstallAppCommand(moduleRef, mock<Dockerode>(), false);

    const result = await preserveDataCommand.execute(appUrn);

    expect(result).toEqual({ success: true, message: `App ${appUrn} uninstalled successfully` });
    expect(appFilesManager.deleteAppDataDir).not.toHaveBeenCalled();
  });

  it('continues uninstall when compose down fails and cleanup helpers remain non-fatal', async () => {
    dockerService.snapshotAppImageIds.mockResolvedValueOnce([]);
    dockerService.composeApp.mockRejectedValueOnce(new Error('compose failed'));

    const result = await command.execute(appUrn);

    expect(result).toEqual({ success: true, message: `App ${appUrn} uninstalled successfully` });
    expect(dockerService.removeAppImages).toHaveBeenCalledWith(appUrn, []);
    expect(dockerService.removeAppNetworks).toHaveBeenCalledWith(appUrn);
    expect(appFilesManager.deleteAppFolder).toHaveBeenCalledWith(appUrn);
  });
});
