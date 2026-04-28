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
    appFilesManager.deleteAppFolder.mockResolvedValue();

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
