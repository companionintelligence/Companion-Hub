import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { UpdateAppCommand } from '../update-app-command';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { ConfigurationService } from '@/core/config/configuration.service';
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
  let appsRepository: ReturnType<typeof mock<AppsRepository>>;
  let configService: ReturnType<typeof mock<ConfigurationService>>;

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
    appsRepository = mock<AppsRepository>();
    configService = mock<ConfigurationService>();
    docker = {} as Dockerode;

    appFilesManager.deleteAppFolder.mockResolvedValue(true);
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app-data/test-app/app.env', content: 'PREVIOUS=1\n' } as any);
    filesystem.removeDirectory.mockResolvedValue(true);
    filesystem.copyDirectory.mockResolvedValue(true);
    appsRepository.getAppByUrn.mockResolvedValue({ maxBackups: null } as any);
    configService.get.mockReturnValue({ maxBackups: 0 } as any);

    marketplaceService.getDockerComposeJson.mockResolvedValue({ content: 'services: {}' } as any);
    backupManager.backupApp.mockResolvedValue({ filename: 'test-app-backup.tar.gz' } as any);
    dockerService.createPreUpdateVolumeSnapshot.mockResolvedValue({
      appUrn,
      snapshotId: 'snap-1',
      timestamp: new Date().toISOString(),
      snapshotBaseDir: '/data/snapshots/test-app/snap-1',
      snapshotPath: '/data/snapshots/test-app/snap-1/app-data',
      appFilesSnapshotPath: '/data/snapshots/test-app/snap-1/app-files',
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
      if (token === AppsRepository) return appsRepository;
      if (token === ConfigurationService) return configService;
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
    // A backup was taken, so the snapshot covers the installed files only.
    expect(dockerService.createPreUpdateVolumeSnapshot).toHaveBeenCalledWith(appUrn, { includeData: false });
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
  describe('pulling before stopping', () => {
    const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0] as number;

    it('pulls the new images before it stops, backs up or tears anything down', async () => {
      await command.execute(appUrn, {});

      expect(dockerService.pullImages).toHaveBeenCalledWith(expect.any(Array), { forcePull: true });
      const pulled = order(dockerService.pullImages);
      const stopped = dockerService.composeApp.mock.calls.findIndex(([, cmd]) => cmd === 'stop');
      expect(pulled).toBeLessThan(dockerService.composeApp.mock.invocationCallOrder[stopped] as number);
      expect(pulled).toBeLessThan(order(backupManager.backupApp));
      expect(pulled).toBeLessThan(order(appFilesManager.deleteAppFolder));
    });

    it('leaves a running app exactly as it was when the pull fails', async () => {
      dockerService.pullImages.mockRejectedValue(new Error('registry unreachable'));

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(dockerService.composeApp).not.toHaveBeenCalled();
      expect(backupManager.backupApp).not.toHaveBeenCalled();
      expect(appFilesManager.deleteAppFolder).not.toHaveBeenCalled();
      expect(marketplaceService.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
    });
  });

  describe('an app that was stopped', () => {
    beforeEach(() => {
      command = new UpdateAppCommand(moduleRef, docker, true, false);
      (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
      (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);
    });

    it('is updated and left stopped', async () => {
      const result = await command.execute(appUrn, {});

      expect(result).toEqual({ success: true, message: `App ${appUrn} updated successfully` });
      expect(marketplaceService.copyAppFromRepoToInstalled).toHaveBeenCalledWith(appUrn);
      const commands = dockerService.composeApp.mock.calls.map(([, cmd]) => cmd);
      expect(commands.some((cmd) => String(cmd).startsWith('up'))).toBe(false);
      expect(commands).not.toContain('pull');
      expect(dockerService.verifyContainerHealthProbe).not.toHaveBeenCalled();
    });

    it('is not started again when an update fails after its files were replaced', async () => {
      marketplaceService.copyAppFromRepoToInstalled.mockRejectedValue(new Error('disk full'));
      filesystem.pathExists.mockResolvedValue(true);

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(filesystem.copyDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1/app-files', '/data/installed/test-app');
      const commands = dockerService.composeApp.mock.calls.map(([, cmd]) => String(cmd));
      expect(commands.some((cmd) => cmd.startsWith('up'))).toBe(false);
    });
  });

  describe('a failure before the files are replaced', () => {
    it('starts a running app again when the backup that stopped it fails', async () => {
      backupManager.backupApp.mockRejectedValue(new Error('no space left on device'));

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'stop');
      expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'up --detach --remove-orphans');
      expect(appFilesManager.deleteAppFolder).not.toHaveBeenCalled();
    });

    it('reports that it could not roll back when restarting the app fails too', async () => {
      backupManager.backupApp.mockRejectedValue(new Error('no space left on device'));
      dockerService.composeApp.mockImplementation(async (_urn, cmd) => {
        if (String(cmd).startsWith('up')) throw new Error('docker daemon not responding');
      });

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: false });
    });
  });

  describe('a failure after the files are replaced', () => {
    beforeEach(() => {
      filesystem.pathExists.mockResolvedValue(true);
      marketplaceService.copyAppFromRepoToInstalled.mockRejectedValue(new Error('could not copy'));
    });

    it('puts the previous files and env back and starts the previous version', async () => {
      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'down --remove-orphans');
      expect(filesystem.removeDirectory).toHaveBeenCalledWith('/data/installed/test-app');
      expect(filesystem.copyDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1/app-files', '/data/installed/test-app');
      expect(appFilesManager.writeAppEnv).toHaveBeenCalledWith(appUrn, 'PREVIOUS=1\n');
      expect(dockerService.composeApp).toHaveBeenLastCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
    });

    it('removes the snapshot once it has served', async () => {
      await command.execute(appUrn, {});

      expect(filesystem.removeDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1');
    });

    it('keeps the snapshot, and says it could not roll back, when the previous files cannot be copied back', async () => {
      filesystem.copyDirectory.mockResolvedValue(false);

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: false });
      expect(filesystem.removeDirectory).not.toHaveBeenCalledWith('/data/snapshots/test-app/snap-1');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('/data/snapshots/test-app/snap-1'));
    });

    it('keeps the snapshot when there is none of the previous files to restore', async () => {
      dockerService.createPreUpdateVolumeSnapshot.mockResolvedValue({
        appUrn,
        snapshotId: 'snap-1',
        timestamp: new Date().toISOString(),
        snapshotBaseDir: '/data/snapshots/test-app/snap-1',
        volumes: [],
        success: false,
        error: 'disk full',
      } as any);

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: false });
      expect(filesystem.removeDirectory).not.toHaveBeenCalledWith('/data/snapshots/test-app/snap-1');
    });
  });

  it('treats a previous folder that cannot be removed as a failure rather than copying over a mix of old and new', async () => {
    appFilesManager.deleteAppFolder.mockResolvedValue(false);
    filesystem.pathExists.mockResolvedValue(true);

    const result = await command.execute(appUrn, {});

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(marketplaceService.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
  });

  it('removes the pre-update snapshot after a successful update', async () => {
    const result = await command.execute(appUrn, {});

    expect(result).toMatchObject({ success: true });
    expect(filesystem.removeDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1');
  });

  it('snapshots the data folder too when no backup was taken', async () => {
    command = new UpdateAppCommand(moduleRef, docker, false);
    (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
    (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);

    await command.execute(appUrn, {});

    expect(dockerService.createPreUpdateVolumeSnapshot).toHaveBeenCalledWith(appUrn, { includeData: true });
  });

  describe('health-probe rollback outcome', () => {
    beforeEach(() => {
      dockerService.verifyContainerHealthProbe.mockResolvedValue({ ok: false, healthy: false, containers: [], message: 'exited' });
    });

    it('reports a rollback when the previous version was brought back up', async () => {
      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
    });

    it('does not run a second rollback over the first', async () => {
      await command.execute(appUrn, {});

      const downs = dockerService.composeApp.mock.calls.filter(([, cmd]) => cmd === 'down --remove-orphans');
      expect(downs).toHaveLength(1);
      expect(backupManager.restoreApp).toHaveBeenCalledTimes(1);
    });

    it('reports no rollback when bringing the previous version back up failed', async () => {
      let ups = 0;
      dockerService.composeApp.mockImplementation(async (_urn, cmd) => {
        if (cmd === 'up --detach --force-recreate --remove-orphans' && ++ups === 2) throw new Error('docker daemon not responding');
      });

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: false });
    });
  });

  describe('backup retention after an update backup', () => {
    it("applies the app's own limit", async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ maxBackups: 3 } as any);

      await command.execute(appUrn, {});

      expect(backupManager.cleanupOldBackups).toHaveBeenCalledWith(appUrn, 3);
    });

    it('falls back to the global limit when the app has none', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ maxBackups: null } as any);
      configService.get.mockReturnValue({ maxBackups: 7 } as any);

      await command.execute(appUrn, {});

      expect(backupManager.cleanupOldBackups).toHaveBeenCalledWith(appUrn, 7);
    });

    it('does not apply any limit when no backup was taken', async () => {
      command = new UpdateAppCommand(moduleRef, docker, false);
      (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
      (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);

      await command.execute(appUrn, {});

      expect(backupManager.cleanupOldBackups).not.toHaveBeenCalled();
    });

    it('does not fail the update when the tidy-up itself fails', async () => {
      backupManager.cleanupOldBackups.mockRejectedValue(new Error('permission denied'));

      const result = await command.execute(appUrn, {});

      expect(result).toEqual({ success: true, message: `App ${appUrn} updated successfully` });
    });
  });
});
