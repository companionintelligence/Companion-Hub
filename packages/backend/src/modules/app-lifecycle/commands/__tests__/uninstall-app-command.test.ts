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
    removeAppDataDirAsRoot: ReturnType<typeof vi.fn>;
  };
  let appFilesManager: MockProxy<AppFilesManager>;
  let portManager: MockProxy<PortManagerService>;

  // Single token-dispatch map for every command built in this suite, so a new
  // constructor dependency only has to be added here.
  const makeModuleRef = () =>
    ({
      get: vi.fn((token: unknown) => {
        if (token === LoggerService) return logger;
        if (token === AppFilesManager) return appFilesManager;
        if (token === DockerService) return dockerService;
        if (token === PortManagerService) return portManager;
        return null;
      }),
    }) as unknown as ModuleRef;

  beforeEach(() => {
    logger = mockDeep<LoggerService>();
    appFilesManager = mock<AppFilesManager>();
    appFilesManager.deleteAppFolder.mockResolvedValue(true);
    appFilesManager.deleteAppDataDir.mockResolvedValue(true);
    appFilesManager.deleteAppDataDirDetailed.mockResolvedValue({ removed: true, permissionDenied: false });
    appFilesManager.getAppDataHostDir.mockReturnValue('/srv/app-data/store/test-app');

    portManager = mock<PortManagerService>();
    portManager.releaseAll.mockResolvedValue(1);

    dockerService = {
      composeApp: vi.fn().mockResolvedValue({ success: true }),
      snapshotAppImageIds: vi.fn().mockResolvedValue(['sha256:a']),
      removeAppImages: vi.fn().mockResolvedValue(undefined),
      removeAppNetworks: vi.fn().mockResolvedValue(undefined),
      removeAppDataDirAsRoot: vi.fn().mockResolvedValue(true),
    };

    command = new UninstallAppCommand(makeModuleRef(), mock<Dockerode>());
  });

  it('runs compose down with --rmi all and explicit image/network cleanup', async () => {
    const result = await command.execute(appUrn);

    expect(result).toEqual({ success: true, message: `App ${appUrn} uninstalled successfully` });
    expect(dockerService.snapshotAppImageIds).toHaveBeenCalledWith(appUrn);
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'down --remove-orphans -v --rmi all');
    expect(dockerService.removeAppImages).toHaveBeenCalledWith(appUrn, ['sha256:a']);
    expect(dockerService.removeAppNetworks).toHaveBeenCalledWith(appUrn);
    expect(appFilesManager.deleteAppFolder).toHaveBeenCalledWith(appUrn);
    expect(appFilesManager.deleteAppDataDirDetailed).toHaveBeenCalledWith(appUrn);
    // Clean delete → no privileged escalation.
    expect(dockerService.removeAppDataDirAsRoot).not.toHaveBeenCalled();

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
    const preserveDataCommand = new UninstallAppCommand(makeModuleRef(), mock<Dockerode>(), false);

    const result = await preserveDataCommand.execute(appUrn);

    expect(result).toEqual({ success: true, message: `App ${appUrn} uninstalled successfully` });
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'down --remove-orphans --rmi all');
    expect(appFilesManager.deleteAppFolder).toHaveBeenCalledWith(appUrn);
    expect(appFilesManager.deleteAppDataDirDetailed).not.toHaveBeenCalled();
  });

  it('reports the remnant with the host path when app-data deletion fails without a permission error (#907)', async () => {
    // A non-permission failure: not worth escalating to root, so surface it directly.
    appFilesManager.deleteAppDataDirDetailed.mockResolvedValue({ removed: false, permissionDenied: false });

    const result = await command.execute(appUrn);

    expect(result).toEqual({
      success: true,
      message: `App ${appUrn} uninstalled, but its app data could not be fully removed and may leave a remnant on disk.`,
      warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
      warningDetail: '/srv/app-data/store/test-app',
    });
    expect(dockerService.removeAppDataDirAsRoot).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not be fully removed'));
  });

  it('still reports a (warning) success — never a fatal error — when the host path cannot be resolved (#918 review)', async () => {
    // getAppDataHostDir is only used to build the manual-cleanup command; if it throws
    // (e.g. a misconfigured non-absolute ROOT_FOLDER_HOST) the uninstall must degrade to a
    // generic remnant warning, NOT flip an already-successful teardown into an error.
    appFilesManager.deleteAppDataDirDetailed.mockResolvedValue({ removed: false, permissionDenied: false });
    appFilesManager.getAppDataHostDir.mockImplementation(() => {
      throw new Error('App data host path must be absolute, got: relative/path');
    });

    const result = await command.execute(appUrn);

    expect(result).toEqual({
      success: true,
      message: `App ${appUrn} uninstalled, but its app data could not be fully removed and may leave a remnant on disk.`,
      warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
      // No warningDetail: the path was unavailable, so no manual command is offered.
    });
    expect(dockerService.removeAppDataDirAsRoot).not.toHaveBeenCalled();
  });

  it('escalates to a privileged cleanup on a permission error, then reports a clean uninstall (#907)', async () => {
    appFilesManager.deleteAppDataDirDetailed.mockResolvedValue({ removed: false, permissionDenied: true });
    dockerService.removeAppDataDirAsRoot.mockResolvedValue(true);
    appFilesManager.deleteAppDataDir.mockResolvedValue(true); // re-check after the helper empties it

    const result = await command.execute(appUrn);

    expect(dockerService.removeAppDataDirAsRoot).toHaveBeenCalledWith(appUrn);
    expect(result).toEqual({ success: true, message: `App ${appUrn} uninstalled successfully` });
  });

  it('surfaces a manual cleanup command when even the privileged cleanup fails (#907)', async () => {
    appFilesManager.deleteAppDataDirDetailed.mockResolvedValue({ removed: false, permissionDenied: true });
    dockerService.removeAppDataDirAsRoot.mockResolvedValue(false);

    const result = await command.execute(appUrn);

    expect(dockerService.removeAppDataDirAsRoot).toHaveBeenCalledWith(appUrn);
    expect(result).toEqual({
      success: true,
      message: `App ${appUrn} uninstalled, but its app data could not be fully removed and may leave a remnant on disk.`,
      warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
      warningDetail: '/srv/app-data/store/test-app',
    });
  });

  it('reports the remnant when the app folder deletion fails (no host path — folder is Hub-owned) (#907)', async () => {
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
    appFilesManager.deleteAppDataDirDetailed.mockResolvedValue({ removed: false, permissionDenied: false });

    const result = await command.execute(appUrn);

    expect(result).toEqual({
      success: true,
      message: `App ${appUrn} uninstalled, but its app folder and app data could not be fully removed and may leave a remnant on disk.`,
      warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
      warningDetail: '/srv/app-data/store/test-app',
    });
  });

  it('does not flag app data as a remnant when data deletion is skipped (deleteAllData=false)', async () => {
    appFilesManager.deleteAppDataDirDetailed.mockResolvedValue({ removed: false, permissionDenied: true }); // never called

    const preserveDataCommand = new UninstallAppCommand(makeModuleRef(), mock<Dockerode>(), false);

    const result = await preserveDataCommand.execute(appUrn);

    expect(result).toEqual({ success: true, message: `App ${appUrn} uninstalled successfully` });
    expect(appFilesManager.deleteAppDataDirDetailed).not.toHaveBeenCalled();
    expect(dockerService.removeAppDataDirAsRoot).not.toHaveBeenCalled();
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
