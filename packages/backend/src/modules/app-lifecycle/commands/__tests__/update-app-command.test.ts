import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { UpdateAppCommand } from '../update-app-command';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DockerService } from '@/modules/docker/docker.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import type { AppUrn } from '@ci-hub/common/types';
import { parseComposeJson } from '@ci-hub/common/schemas';

vi.mock('@ci-hub/common/schemas', async (importOriginal) => ({
  ...((await importOriginal()) as any),
  parseComposeJson: vi.fn().mockReturnValue({ services: [], overrides: [] }),
}));

describe('UpdateAppCommand', () => {
  let command: UpdateAppCommand;
  let moduleRef: ReturnType<typeof mock<ModuleRef>>;
  let docker: Dockerode;
  let logger: ReturnType<typeof mockDeep<LoggerService>>;
  let appFilesManager: ReturnType<typeof mock<AppFilesManager>>;
  let dockerService: ReturnType<typeof mock<DockerService>>;
  let marketplaceService: ReturnType<typeof mock<MarketplaceService>>;
  let appHelpers: ReturnType<typeof mock<AppHelpers>>;
  let backupManager: ReturnType<typeof mock<BackupManager>>;
  let filesystem: ReturnType<typeof mock<FilesystemService>>;
  let agentNotifyService: ReturnType<typeof mock<AgentNotifyService>>;

  const appUrn = 'urn:store:test-app' as AppUrn;

  beforeEach(() => {
    vi.mocked(parseComposeJson).mockReturnValue({ services: [], overrides: [] } as any);

    logger = mockDeep<LoggerService>();
    appFilesManager = mock<AppFilesManager>();
    dockerService = mock<DockerService>();
    marketplaceService = mock<MarketplaceService>();
    appHelpers = mock<AppHelpers>();
    backupManager = mock<BackupManager>();
    filesystem = mock<FilesystemService>();
    agentNotifyService = mock<AgentNotifyService>();
    docker = {} as Dockerode;

    marketplaceService.getDockerComposeJson.mockResolvedValue({ content: 'services: {}' } as any);
    backupManager.backupApp.mockResolvedValue({ filename: 'test-app-backup.tar.gz' } as any);
    dockerService.createPreUpdateVolumeSnapshot.mockResolvedValue({
      appUrn,
      snapshotId: 'snap-1',
      timestamp: new Date().toISOString(),
      snapshotPath: '/data/snapshots/test-app/snap-1/app-data',
      volumes: [],
      success: true,
    });
    dockerService.verifyContainerHealthProbe.mockResolvedValue({
      ok: true,
      healthy: true,
      containers: [],
      message: 'All containers healthy',
    });
    dockerService.composeApp.mockResolvedValue(undefined as any);
    appFilesManager.getAppPaths.mockReturnValue({
      appDataDir: '/data/app-data/test-app',
      appInstalledDir: '/data/installed/test-app',
    } as any);

    moduleRef = mock<ModuleRef>();
    moduleRef.get.mockImplementation((token: unknown) => {
      if (token === LoggerService) return logger;
      if (token === AppFilesManager) return appFilesManager;
      if (token === DockerService) return dockerService;
      if (token === MarketplaceService) return marketplaceService;
      if (token === AppHelpers) return appHelpers;
      if (token === BackupManager) return backupManager;
      if (token === FilesystemService) return filesystem;
      if (token === AgentNotifyService) return agentNotifyService;
      return undefined as any;
    });

    command = new UpdateAppCommand(moduleRef, docker, true);
    // Bypass entitlement check in command base
    (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
    (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);
  });

  it('successfully executes update when health check passes', async () => {
    const result = await command.execute(appUrn, {});

    expect(result).toEqual({ success: true, message: `App ${appUrn} updated successfully` });
    expect(backupManager.backupApp).toHaveBeenCalledWith(appUrn);
    expect(dockerService.createPreUpdateVolumeSnapshot).toHaveBeenCalledWith(appUrn);
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'pull');
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
    expect(dockerService.verifyContainerHealthProbe).toHaveBeenCalledWith(appUrn, { maxAttempts: 5, delayMs: 2000 });
  });

  it('triggers auto-rollback using backup when post-update health probe fails', async () => {
    dockerService.verifyContainerHealthProbe.mockResolvedValue({
      ok: false,
      healthy: false,
      containers: [],
      message: 'Container app-backend exited with code 1',
    });

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(backupManager.restoreApp).toHaveBeenCalledWith(appUrn, 'test-app-backup.tar.gz');
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'down --remove-orphans');
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
  });

  it('triggers auto-rollback from snapshot when no backup was performed and probe fails', async () => {
    command = new UpdateAppCommand(moduleRef, docker, false);
    (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
    (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);

    filesystem.pathExists.mockResolvedValue(true);
    dockerService.verifyContainerHealthProbe.mockResolvedValue({
      ok: false,
      healthy: false,
      containers: [],
      message: 'Container app-backend is restarting',
    });

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(backupManager.restoreApp).not.toHaveBeenCalled();
    expect(filesystem.copyDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1/app-data', '/data/app-data/test-app');
  });

  it('also restores the installed app files from the snapshot, not just app data', async () => {
    command = new UpdateAppCommand(moduleRef, docker, false);
    (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
    (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);

    dockerService.createPreUpdateVolumeSnapshot.mockResolvedValue({
      appUrn,
      snapshotId: 'snap-1',
      timestamp: new Date().toISOString(),
      snapshotPath: '/data/snapshots/test-app/snap-1/app-data',
      appFilesSnapshotPath: '/data/snapshots/test-app/snap-1/app-files',
      volumes: [],
      success: true,
    } as any);
    filesystem.pathExists.mockResolvedValue(true);
    dockerService.verifyContainerHealthProbe.mockResolvedValue({
      ok: false,
      healthy: false,
      containers: [],
      message: 'Container app-backend is restarting',
    });

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(filesystem.copyDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1/app-files', '/data/installed/test-app');
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
  });

  it('still attempts to bring the app back up when the data/files restore itself fails, rather than leaving it torn down', async () => {
    command = new UpdateAppCommand(moduleRef, docker, false);
    (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
    (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);

    filesystem.pathExists.mockResolvedValue(true);
    filesystem.copyDirectory.mockRejectedValue(new Error('disk full'));
    dockerService.verifyContainerHealthProbe.mockResolvedValue({
      ok: false,
      healthy: false,
      containers: [],
      message: 'Container app-backend is restarting',
    });

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    // `down` happened, the restore failed, but we must still try to recreate the app rather
    // than leaving it fully offline.
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'down --remove-orphans');
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
  });

  it('still attempts to bring the app back up when restoreApp itself throws', async () => {
    backupManager.restoreApp.mockRejectedValue(new Error('backup archive is corrupt'));
    dockerService.verifyContainerHealthProbe.mockResolvedValue({
      ok: false,
      healthy: false,
      containers: [],
      message: 'Container app-backend exited with code 1',
    });

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
  });

  it('does not roll back at all when only one-shot init containers are non-running and the app is otherwise healthy', async () => {
    dockerService.verifyContainerHealthProbe.mockResolvedValue({
      ok: true,
      healthy: true,
      containers: [
        { id: 'c1', name: 'ci-memory-api-1', status: 'Up', state: 'running', healthStatus: null, hasHealthCheck: false, exitCode: null },
        {
          id: 'c2',
          name: 'ci-memory-migrate-database-1',
          status: 'Exited (0)',
          state: 'exited',
          healthStatus: null,
          hasHealthCheck: false,
          exitCode: 0,
        },
      ],
      message: 'All containers for ci-memory:ci-marketplace passed health probes',
    });

    const result = await command.execute(appUrn, {});

    expect(result).toEqual({ success: true, message: `App ${appUrn} updated successfully` });
    expect(backupManager.restoreApp).not.toHaveBeenCalled();
    expect(dockerService.composeApp).not.toHaveBeenCalledWith(appUrn, 'down --remove-orphans');
  });
});
