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
import { SSEService } from '@/core/sse/sse.service';
import { AppCommandDeadline } from '@/common/helpers/app-command-deadline';
import type { CommandExecutionContext } from '../command';
import type { AppUrn } from '@ci-hub/common/types';
import { parseComposeJson } from '@ci-hub/common/schemas';

// An installed compose is read with parseInstalledComposeJson: one stub stands for both parses.
vi.mock('@ci-hub/common/schemas', async (importOriginal) => {
  const parse = vi.fn().mockReturnValue({ services: [], overrides: [] });
  return { ...((await importOriginal()) as any), parseComposeJson: parse, parseInstalledComposeJson: parse };
});

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
  let sseService: ReturnType<typeof mock<SSEService>>;

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
    sseService = mock<SSEService>();
    docker = {} as Dockerode;

    appFilesManager.deleteAppFolder.mockResolvedValue(true);
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app-data/test-app/app.env', content: 'PREVIOUS=1\n' } as any);
    filesystem.removeDirectory.mockResolvedValue(true);
    filesystem.removeDirectoryDetailed.mockResolvedValue({ removed: true, permissionDenied: false });
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
      if (token === SSEService) return sseService;
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
    expect(backupManager.backupApp).toHaveBeenCalledWith(appUrn, undefined);
    // A backup was taken, so the snapshot covers the installed files only.
    expect(dockerService.createPreUpdateVolumeSnapshot).toHaveBeenCalledWith(appUrn, { includeData: false });
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'pull');
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
    // An app whose health check still says `starting` is waited for rather than rolled back.
    expect(dockerService.verifyContainerHealthProbe).toHaveBeenCalledWith(appUrn, { maxAttempts: 5, delayMs: 2000, waitWhileStarting: true });
  });

  // app.env is built from the installed config.json. Written only before the copy, it gave the new
  // version the previous version's environment (APP_IMAGE_TAG=latest for Uptime Kuma 2.5.6). The
  // start after the update then rewrote it, so compose recreated the container mid-conversion (#2106).
  // `compose pull` reads app.env too (`--env-file`), so the write has to come before the pull as well as the start.
  it("writes app.env from the new version's files before pulling and starting it", async () => {
    await command.execute(appUrn, {});

    const copiedAt = marketplaceService.copyAppFromRepoToInstalled.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const pullIndex = dockerService.composeApp.mock.calls.findIndex(([, cmd]) => cmd === 'pull');
    const pulledAt = dockerService.composeApp.mock.invocationCallOrder[pullIndex] ?? Number.NEGATIVE_INFINITY;

    expect(appHelpers.generateEnvFile.mock.invocationCallOrder.some((at) => at > copiedAt && at < pulledAt)).toBe(true);
  });

  it("puts the previous version back when app.env cannot be written from the new version's files", async () => {
    filesystem.pathExists.mockResolvedValue(true);
    appHelpers.generateEnvFile.mockResolvedValueOnce(undefined as any).mockRejectedValueOnce(new Error('Variable API key is required'));

    const result = await command.execute(appUrn, {});

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(dockerService.composeApp).not.toHaveBeenCalledWith(appUrn, 'pull');
    expect(filesystem.copyDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1/app-files', '/data/installed/test-app');
    expect(appFilesManager.writeAppEnv).toHaveBeenCalledWith(appUrn, 'PREVIOUS=1\n');
    expect(dockerService.composeApp).toHaveBeenLastCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
  });

  it('logs how long the new version took to pass its health check', async () => {
    dockerService.verifyContainerHealthProbe.mockResolvedValue({
      ok: true,
      healthy: true,
      containers: [],
      message: `All containers for ${appUrn} passed health probes after 16 s`,
    });

    await command.execute(appUrn, {});

    expect(logger.info).toHaveBeenCalledWith(
      `Post-update health check passed for app ${appUrn}: All containers for ${appUrn} passed health probes after 16 s`,
    );
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
    expect(backupManager.restoreApp).toHaveBeenCalledWith(appUrn, 'test-app-backup.tar.gz', undefined);
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

      expect(dockerService.pullImages).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ forcePull: true }));
      const pulled = order(dockerService.pullImages);
      const stopped = dockerService.composeApp.mock.calls.findIndex(([, cmd]) => cmd === 'stop');
      expect(pulled).toBeLessThan(dockerService.composeApp.mock.invocationCallOrder[stopped] as number);
      expect(pulled).toBeLessThan(order(backupManager.backupApp));
      expect(pulled).toBeLessThan(order(appFilesManager.deleteAppFolder));
    });

    it('records the new version of an image the app recorded before, so an uninstall removes it too', async () => {
      vi.mocked(parseComposeJson).mockReturnValue({ services: [{ name: 'app', image: 'app-image:1' }], overrides: [] } as any);
      let pulled = false;
      dockerService.pullImages.mockImplementation(async () => {
        pulled = true;
      });
      dockerService.imageIdLocally.mockImplementation(async () => (pulled ? 'sha256:v2' : 'sha256:v1'));
      appFilesManager.readPulledImageIds.mockResolvedValue(['sha256:v1']);
      appFilesManager.writePulledImageIds.mockResolvedValue(true);

      await command.execute(appUrn, {});

      expect(appFilesManager.writePulledImageIds).toHaveBeenCalledWith(appUrn, ['sha256:v1', 'sha256:v2']);
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

    // app.env lives in the data folder, which this rollback does not touch. With no previous one to put
    // back, the one the update built from the new version's files stayed beside the previous files.
    it('builds app.env again from the previous files when there was none to put back', async () => {
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app-data/test-app/app.env', content: '' } as any);
      marketplaceService.copyAppFromRepoToInstalled.mockResolvedValue(undefined as any);
      dockerService.composeApp.mockImplementation(async (_appUrn, cmd) => {
        if (cmd === 'pull') {
          throw new Error('pull failed');
        }
        return undefined as any;
      });

      const result = await command.execute(appUrn, {});

      const restoredAt = filesystem.copyDirectory.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY;
      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(appFilesManager.writeAppEnv).not.toHaveBeenCalled();
      expect(appHelpers.generateEnvFile.mock.invocationCallOrder.at(-1)).toBeGreaterThan(restoredAt);
    });

    it('removes the snapshot once it has served', async () => {
      await command.execute(appUrn, {});
      await command.afterReply();

      expect(filesystem.removeDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1');
    });

    it('keeps the snapshot, and says it could not roll back, when the previous files cannot be copied back', async () => {
      filesystem.copyDirectory.mockResolvedValue(false);

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: false });
      expect(filesystem.removeDirectory).not.toHaveBeenCalledWith('/data/snapshots/test-app/snap-1');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('/data/snapshots/test-app/snap-1'));
    });

    it('keeps the snapshot when it holds none of the previous files to restore', async () => {
      dockerService.createPreUpdateVolumeSnapshot.mockResolvedValue({
        appUrn,
        snapshotId: 'snap-1',
        timestamp: new Date().toISOString(),
        snapshotBaseDir: '/data/snapshots/test-app/snap-1',
        volumes: [],
        success: true,
      } as any);

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: false });
      expect(filesystem.removeDirectory).not.toHaveBeenCalledWith('/data/snapshots/test-app/snap-1');
    });
  });

  // On a native-Linux Hub (it runs as the host user, not root) a database's files belong to the user its
  // container ran as. The Hub cannot read them itself, but a privileged helper copies them both for the
  // backup (see BackupManager) and for the rollback snapshot.
  describe('an app whose data the Hub cannot read (a database owned by another user)', () => {
    it('asks whether the backup can be made before it stops the app, then backs it up', async () => {
      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: true });
      expect(backupManager.assertBackupPossible).toHaveBeenCalledWith(appUrn);
      const stop = dockerService.composeApp.mock.calls.findIndex(([, args]) => args === 'stop');
      expect(backupManager.assertBackupPossible.mock.invocationCallOrder[0]).toBeLessThan(
        dockerService.composeApp.mock.invocationCallOrder[stop] as number,
      );
      expect(backupManager.backupApp).toHaveBeenCalledWith(appUrn, undefined);
    });

    it('stops nothing when the backup cannot be made (the helper for unreadable data cannot run)', async () => {
      backupManager.assertBackupPossible.mockRejectedValue(new Error(`Cannot back up ${appUrn}: … Nothing was stopped.`));

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(result.message).toContain('Nothing was stopped');
      expect(dockerService.composeApp).not.toHaveBeenCalled();
      expect(backupManager.backupApp).not.toHaveBeenCalled();
    });

    it('snapshots the data when no backup was asked for, since the snapshot can be taken by a helper', async () => {
      command = new UpdateAppCommand(moduleRef, docker, false);
      (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
      (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: true });
      expect(dockerService.createPreUpdateVolumeSnapshot).toHaveBeenCalledWith(appUrn, { includeData: true });
    });

    describe('with a data snapshot a privileged helper copied', () => {
      beforeEach(() => {
        command = new UpdateAppCommand(moduleRef, docker, false);
        (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
        (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);
        filesystem.pathExists.mockResolvedValue(true);
        dockerService.createPreUpdateVolumeSnapshot.mockResolvedValue({
          appUrn,
          snapshotId: 'pre-update-test-app-1',
          timestamp: new Date().toISOString(),
          snapshotBaseDir: '/data/backups/.pre-update-snapshots/store/test-app/pre-update-test-app-1',
          snapshotPath: '/data/backups/.pre-update-snapshots/store/test-app/pre-update-test-app-1/app-data',
          appFilesSnapshotPath: '/data/backups/.pre-update-snapshots/store/test-app/pre-update-test-app-1/app-files',
          dataSnapshotCopiedAsRoot: true,
          volumes: [],
          success: true,
        });
        dockerService.restoreAppDataDirAsRoot.mockResolvedValue(true);
        dockerService.removeSnapshotDirAsRoot.mockResolvedValue(true);
      });

      it('puts the data back with the helper, not the Hub, when the new version fails its health probe', async () => {
        dockerService.verifyContainerHealthProbe.mockResolvedValue({
          ok: false,
          healthy: false,
          containers: [],
          message: 'Container db is restarting',
        });

        const result = await command.execute(appUrn, {});

        expect(result.success).toBe(false);
        expect(dockerService.restoreAppDataDirAsRoot).toHaveBeenCalledWith(appUrn, 'pre-update-test-app-1', undefined);
        // The Hub itself could neither empty nor write a database's files.
        expect(filesystem.copyDirectory).not.toHaveBeenCalledWith(expect.stringContaining('/app-data'), '/data/app-data/test-app');
      });

      it('does not report a rollback that restored nothing when the helper fails', async () => {
        dockerService.verifyContainerHealthProbe.mockResolvedValue({
          ok: false,
          healthy: false,
          containers: [],
          message: 'Container db is restarting',
        });
        dockerService.restoreAppDataDirAsRoot.mockResolvedValue(false);

        const result = await command.execute(appUrn, {});

        expect(result.success).toBe(false);
        expect(result.rolledBack).not.toBe(true);
        // The snapshot is the only remaining copy: it is kept.
        expect(dockerService.removeSnapshotDirAsRoot).not.toHaveBeenCalled();
      });

      it('empties the root-owned snapshot with the helper before removing it once the update has succeeded', async () => {
        const result = await command.execute(appUrn, {});
        await command.afterReply();

        expect(result).toMatchObject({ success: true });
        expect(dockerService.removeSnapshotDirAsRoot).toHaveBeenCalledWith(appUrn, 'pre-update-test-app-1');
        expect(dockerService.removeSnapshotDirAsRoot.mock.invocationCallOrder[0]).toBeLessThan(
          filesystem.removeDirectory.mock.invocationCallOrder.at(-1) as number,
        );
        expect(filesystem.removeDirectory).toHaveBeenCalledWith('/data/backups/.pre-update-snapshots/store/test-app/pre-update-test-app-1');
      });
    });
  });

  describe('a snapshot that could not be taken', () => {
    beforeEach(() => {
      dockerService.createPreUpdateVolumeSnapshot.mockResolvedValue({
        appUrn,
        snapshotId: 'snap-1',
        timestamp: new Date().toISOString(),
        snapshotBaseDir: '/data/snapshots/test-app/snap-1',
        volumes: [],
        success: false,
        error: 'disk full',
      } as any);
    });

    it('stops the update before anything is replaced, and starts the app the backup stopped', async () => {
      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(result.message).toContain('disk full');
      expect(appFilesManager.deleteAppFolder).not.toHaveBeenCalled();
      expect(marketplaceService.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
      expect(dockerService.composeApp).not.toHaveBeenCalledWith(appUrn, 'down --rmi local --remove-orphans');
      expect(dockerService.composeApp).toHaveBeenLastCalledWith(appUrn, 'up --detach --remove-orphans');
    });

    it('leaves a running app alone when no backup stopped it', async () => {
      command = new UpdateAppCommand(moduleRef, docker, false);
      (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
      (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(dockerService.composeApp).not.toHaveBeenCalled();
    });
  });

  describe('a failure while the old version is still running', () => {
    beforeEach(() => {
      command = new UpdateAppCommand(moduleRef, docker, false);
      (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
      (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);
      filesystem.pathExists.mockResolvedValue(true);
      appHelpers.generateEnvFile.mockRejectedValue(new Error('app.env is read-only'));
    });

    it('puts the files back without stopping or restarting the app', async () => {
      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(filesystem.copyDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1/app-files', '/data/installed/test-app');
      // Not one container was touched, so none is taken down for the restore or started afterwards.
      expect(dockerService.composeApp).not.toHaveBeenCalled();
    });

    // The rebuild fails for the reason the update did, and nothing was written, so app.env is as it was.
    it('still counts the files as put back when there was no app.env and none can be built', async () => {
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app-data/test-app/app.env', content: '' } as any);

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(dockerService.composeApp).not.toHaveBeenCalled();
    });

    it('starts an app the backup stopped again when there was no app.env and none can be built', async () => {
      command = new UpdateAppCommand(moduleRef, docker, true);
      (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
      (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app-data/test-app/app.env', content: '' } as any);

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(dockerService.composeApp).toHaveBeenLastCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
    });
  });

  describe('a failure when stopping the app for the backup', () => {
    it('starts the app again, because stopping may have got part of the way', async () => {
      dockerService.composeApp.mockImplementation(async (_urn, cmd) => {
        if (cmd === 'stop') throw new Error('timed out stopping a container');
      });

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(backupManager.backupApp).not.toHaveBeenCalled();
      expect(dockerService.composeApp).toHaveBeenLastCalledWith(appUrn, 'up --detach --remove-orphans');
    });
  });

  describe('a failure after the new version was started', () => {
    it('restores the data as well as the files when starting it throws', async () => {
      dockerService.composeApp.mockImplementation(async (_urn, cmd) => {
        if (
          cmd === 'up --detach --force-recreate --remove-orphans' &&
          dockerService.composeApp.mock.calls.filter(([, c]) => c === cmd).length === 1
        ) {
          throw new Error('port is already allocated');
        }
      });

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(backupManager.restoreApp).toHaveBeenCalledWith(appUrn, 'test-app-backup.tar.gz', undefined);
    });

    it('keeps the snapshot, and says it could not roll back, when the backup cannot be restored', async () => {
      backupManager.restoreApp.mockRejectedValue(new Error('backup archive is corrupt'));
      dockerService.verifyContainerHealthProbe.mockResolvedValue({ ok: false, healthy: false, containers: [], message: 'exited' });

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: false });
      expect(filesystem.removeDirectory).not.toHaveBeenCalledWith('/data/snapshots/test-app/snap-1');
      // The previous version is still started: the app must not stay torn down.
      expect(dockerService.composeApp).toHaveBeenLastCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('The backup file has been kept'));
    });

    it('keeps the snapshot when the data cannot be copied back from it', async () => {
      command = new UpdateAppCommand(moduleRef, docker, false);
      (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
      (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);
      filesystem.pathExists.mockResolvedValue(true);
      filesystem.copyDirectory.mockResolvedValue(false);
      dockerService.verifyContainerHealthProbe.mockResolvedValue({ ok: false, healthy: false, containers: [], message: 'exited' });

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, rolledBack: false });
      expect(filesystem.removeDirectory).not.toHaveBeenCalledWith('/data/snapshots/test-app/snap-1');
    });
  });

  it('reports a compose file that does not parse as rolled back, since nothing was touched', async () => {
    vi.mocked(parseComposeJson).mockImplementation(() => {
      throw new Error('unsupported schema');
    });

    const result = await command.execute(appUrn, {});

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(dockerService.pullImages).not.toHaveBeenCalled();
    expect(dockerService.composeApp).not.toHaveBeenCalled();
  });

  it('treats a previous folder that cannot be removed as a failure rather than copying over a mix of old and new', async () => {
    appFilesManager.deleteAppFolder.mockResolvedValue(false);
    filesystem.pathExists.mockResolvedValue(true);

    const result = await command.execute(appUrn, {});

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(marketplaceService.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
  });

  it('removes the pre-update snapshot after a successful update, once the reply is out', async () => {
    const result = await command.execute(appUrn, {});
    expect(filesystem.removeDirectory).not.toHaveBeenCalledWith('/data/snapshots/test-app/snap-1');
    // Said before the reply, so a Hub stopped before the removal leaves a line naming the folder.
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('/data/snapshots/test-app/snap-1 is no longer needed'));
    await command.afterReply();

    expect(result).toMatchObject({ success: true });
    expect(filesystem.removeDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1');
    expect(logger.info).toHaveBeenCalledWith('Removed the pre-update snapshot /data/snapshots/test-app/snap-1');
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

  // The health wait from #2104 can take minutes. The app page showed "Preparing..." all along. A
  // cancel was answered "cancelling" and ignored. The steps' own limits added up to more than the
  // service waits for the reply (#2107).
  describe('progress, cancel and the deadline', () => {
    const MIN = 60_000;
    let controller: AbortController;
    let ctx: CommandExecutionContext & { setPhase: ReturnType<typeof vi.fn> };

    const phasesShown = () =>
      sseService.emit.mock.calls.map(([, data]) => (data as any).updatePhase).filter((phase): phase is string => phase !== undefined);

    beforeEach(() => {
      controller = new AbortController();
      ctx = { signal: controller.signal, setPhase: vi.fn(), deadline: AppCommandDeadline.after(40 * MIN) };
    });

    it('shows each step of the update on the app page and tells the registry what a cancel may do', async () => {
      const result = await command.execute(appUrn, {}, ctx);

      expect(result).toMatchObject({ success: true });
      expect(phasesShown()).toEqual(['preparing', 'pulling', 'backing_up', 'starting', 'verifying', 'finalizing']);
      expect(sseService.emit).toHaveBeenCalledWith('app', { event: 'status_change', appUrn, appStatus: 'updating', updatePhase: 'verifying' });
      expect(ctx.setPhase.mock.calls.map(([phase]) => phase)).toEqual(['preparing', 'pulling', 'preparing', 'composing', 'verifying', 'finalizing']);
    });

    it('says a stopped app is getting its new files, not that it is being started', async () => {
      command = new UpdateAppCommand(moduleRef, docker, true, false);
      (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
      (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);

      await command.execute(appUrn, {}, ctx);

      expect(phasesShown()).toEqual(['preparing', 'pulling', 'backing_up', 'replacing', 'finalizing']);
    });

    it('rolls back to the previous version when cancelled during the health wait', async () => {
      dockerService.verifyContainerHealthProbe.mockImplementation(async () => {
        controller.abort();
        return { ok: false, healthy: false, cancelled: true, containers: [], message: 'cancelled' };
      });

      const result = await command.execute(appUrn, {}, ctx);

      expect(result).toMatchObject({ success: false, cancelled: true, rolledBack: true });
      expect(backupManager.restoreApp).toHaveBeenCalledWith(appUrn, 'test-app-backup.tar.gz', ctx.deadline);
      expect(dockerService.composeApp).toHaveBeenLastCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
      expect(phasesShown().at(-1)).toBe('rolling_back');
    });

    it('stops at the next safe point when cancelled while downloading, before anything was stopped', async () => {
      dockerService.pullImages.mockImplementation(async () => {
        controller.abort();
        throw new Error('pull aborted');
      });

      const result = await command.execute(appUrn, {}, ctx);

      expect(result).toMatchObject({ success: false, cancelled: true, rolledBack: true });
      expect(dockerService.composeApp).not.toHaveBeenCalled();
      expect(backupManager.backupApp).not.toHaveBeenCalled();
      expect(phasesShown()).not.toContain('rolling_back');
    });

    it('finishes the step it is in when cancelled mid-step, then rolls back before the new version runs', async () => {
      // The cancel arrives while the old version is being taken down. The update finishes replacing
      // the files, stops before starting the new version and puts the previous files back; the data
      // was never touched, so no restore from the backup is needed.
      filesystem.pathExists.mockResolvedValue(true);
      dockerService.composeApp.mockImplementation(async (_urn, cmd) => {
        if (cmd === 'down --rmi local --remove-orphans') {
          controller.abort();
        }
      });

      const result = await command.execute(appUrn, {}, ctx);

      expect(result).toMatchObject({ cancelled: true, rolledBack: true });
      expect(marketplaceService.copyAppFromRepoToInstalled).toHaveBeenCalled();
      expect(dockerService.composeApp).not.toHaveBeenCalledWith(appUrn, 'pull');
      expect(dockerService.verifyContainerHealthProbe).not.toHaveBeenCalled();
      expect(backupManager.restoreApp).not.toHaveBeenCalled();
      expect(filesystem.copyDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1/app-files', '/data/installed/test-app');
      expect(dockerService.composeApp).toHaveBeenLastCalledWith(appUrn, 'up --detach --force-recreate --remove-orphans');
    });

    it('gives the pull and the health wait only the time the update has left before its rollback reserve', async () => {
      ctx.deadline = AppCommandDeadline.after(30 * MIN);
      const { endsAt } = ctx.deadline;

      await command.execute(appUrn, {}, ctx);

      const [, pullOptions] = dockerService.pullImages.mock.calls[0] ?? [];
      expect(pullOptions?.signal).toBe(controller.signal);
      // 30 minutes left, 10 kept for a rollback: the pull gets about 20, not its usual 45.
      expect(pullOptions?.timeoutMs).toBeGreaterThan(19 * MIN);
      expect(pullOptions?.timeoutMs).toBeLessThanOrEqual(20 * MIN);
      expect(dockerService.verifyContainerHealthProbe).toHaveBeenCalledWith(
        appUrn,
        expect.objectContaining({ waitUntil: endsAt - 10 * MIN, signal: controller.signal }),
      );
    });

    // backupApp and restoreApp each started a fresh 40-minute budget of their own, so a rollback
    // restore could run on to about minute 75 while the page already showed the update as failed.
    it("gives the backup the update's work time, ending before the rollback reserve", async () => {
      await command.execute(appUrn, {}, ctx);

      const [, backupDeadline] = backupManager.backupApp.mock.calls[0] ?? [];
      expect(backupDeadline?.endsAt).toBe((ctx.deadline?.endsAt ?? 0) - 10 * MIN);
    });

    it('gives the rollback restore only the time left until the reply is due', async () => {
      dockerService.verifyContainerHealthProbe.mockResolvedValue({ ok: false, healthy: false, containers: [], message: 'unhealthy' });

      await command.execute(appUrn, {}, ctx);

      const [, file, restoreDeadline] = backupManager.restoreApp.mock.calls[0] ?? [];
      expect(file).toBe('test-app-backup.tar.gz');
      expect(restoreDeadline).toBe(ctx.deadline);
      expect(restoreDeadline?.remainingMs()).toBeLessThanOrEqual(40 * MIN);
    });

    it('gives the root delete of a snapshot rollback the same deadline', async () => {
      command = new UpdateAppCommand(moduleRef, docker, false);
      (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
      (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);
      filesystem.pathExists.mockResolvedValue(true);
      filesystem.removeDirectoryDetailed.mockResolvedValue({ removed: false, permissionDenied: true });
      dockerService.removeAppDataDirAsRoot.mockResolvedValue(true);
      dockerService.verifyContainerHealthProbe.mockResolvedValue({ ok: false, healthy: false, containers: [], message: 'unhealthy' });

      await command.execute(appUrn, {}, ctx);

      expect(dockerService.removeAppDataDirAsRoot).toHaveBeenCalledWith(appUrn, ctx.deadline);
    });

    // A rollback with no backup copies the snapshot back as root. That helper had 30 minutes of its own,
    // so an update that failed near the end of its work time could go on copying data past the reply,
    // while the page already showed it failed and stopped.
    describe('with a root-owned data snapshot and no backup', () => {
      const rootSnapshot = {
        appUrn,
        snapshotId: 'pre-update-test-app-1',
        timestamp: new Date().toISOString(),
        snapshotBaseDir: '/data/backups/.pre-update-snapshots/store/test-app/pre-update-test-app-1',
        snapshotPath: '/data/backups/.pre-update-snapshots/store/test-app/pre-update-test-app-1/app-data',
        appFilesSnapshotPath: '/data/backups/.pre-update-snapshots/store/test-app/pre-update-test-app-1/app-files',
        dataSnapshotCopiedAsRoot: true,
        volumes: [],
        success: true,
      };

      beforeEach(() => {
        command = new UpdateAppCommand(moduleRef, docker, false);
        (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
        (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);
        filesystem.pathExists.mockResolvedValue(true);
        dockerService.createPreUpdateVolumeSnapshot.mockResolvedValue(rootSnapshot);
        dockerService.restoreAppDataDirAsRoot.mockResolvedValue(true);
        dockerService.removeSnapshotDirAsRoot.mockResolvedValue(true);
      });

      it("copies the data into the snapshot within the update's work time", async () => {
        await command.execute(appUrn, {}, ctx);

        const [, options] = dockerService.createPreUpdateVolumeSnapshot.mock.calls[0] ?? [];
        expect(options).toMatchObject({ includeData: true });
        expect(options?.deadline?.endsAt).toBe((ctx.deadline?.endsAt ?? 0) - 10 * MIN);
      });

      it('copies the snapshot back within the time left until the reply, near the deadline too', async () => {
        vi.useFakeTimers();
        try {
          ctx.deadline = AppCommandDeadline.after(20 * MIN);
          dockerService.verifyContainerHealthProbe.mockImplementation(async () => {
            // The health wait used the whole work time: the rollback starts with the reserve left.
            vi.advanceTimersByTime(10 * MIN);
            return { ok: false, healthy: false, containers: [], message: 'unhealthy' };
          });

          await command.execute(appUrn, {}, ctx);

          const [, , restoreDeadline] = dockerService.restoreAppDataDirAsRoot.mock.calls[0] ?? [];
          expect(restoreDeadline).toBe(ctx.deadline);
          // What the helper gets is what is left until the reply is due, not 30 minutes of its own.
          expect(restoreDeadline?.remainingMs()).toBeLessThanOrEqual(10 * MIN);
        } finally {
          vi.useRealTimers();
        }
      });

      // Emptying a snapshot the update no longer needs must not wait for, or eat into, the reply. A
      // snapshot left on disk because the deadline was used up would never be removed by anything.
      it("empties a no-longer-needed snapshot after the reply, with the helper's own time, even when the rollback used the whole deadline", async () => {
        vi.useFakeTimers();
        try {
          ctx.deadline = AppCommandDeadline.after(20 * MIN);
          dockerService.verifyContainerHealthProbe.mockImplementation(async () => {
            vi.advanceTimersByTime(10 * MIN);
            return { ok: false, healthy: false, containers: [], message: 'unhealthy' };
          });
          dockerService.restoreAppDataDirAsRoot.mockImplementation(async () => {
            // The rollback's copy back used everything that was left.
            vi.advanceTimersByTime(10 * MIN);
            return true;
          });
          let emptied: () => void = () => undefined;
          dockerService.removeSnapshotDirAsRoot.mockImplementation(
            () =>
              new Promise<boolean>((resolve) => {
                emptied = () => resolve(true);
              }),
          );

          const result = await command.execute(appUrn, {}, ctx);

          // The reply is ready while the snapshot has not even been touched.
          expect(result).toMatchObject({ success: false, rolledBack: true });
          expect(ctx.deadline.expired).toBe(true);
          expect(dockerService.removeSnapshotDirAsRoot).not.toHaveBeenCalled();

          const tidying = command.afterReply();
          await Promise.resolve();
          // Started after the reply with no deadline, so it gets the helper's 30 minutes.
          expect(dockerService.removeSnapshotDirAsRoot).toHaveBeenCalledWith(appUrn, 'pre-update-test-app-1');
          emptied();
          await tidying;
          expect(filesystem.removeDirectory).toHaveBeenCalledWith(rootSnapshot.snapshotBaseDir);
        } finally {
          vi.useRealTimers();
        }
      });

      it('leaves the snapshot and says so when the helper cannot empty it', async () => {
        dockerService.removeSnapshotDirAsRoot.mockResolvedValue(false);

        await command.execute(appUrn, {}, ctx);
        await command.afterReply();

        expect(filesystem.removeDirectory).not.toHaveBeenCalledWith(rootSnapshot.snapshotBaseDir);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('it is left on disk'));
      });
    });

    it('does not start an update that waited in the queue until too little of its time was left', async () => {
      // Queued 28 minutes ago with the usual 45-minute wait: 12 minutes of its deadline are left.
      ctx.deadline = AppCommandDeadline.untilReply(Date.now() - 28 * MIN, 45 * MIN);

      const result = await command.execute(appUrn, {}, ctx);

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(result.message).toContain('too little of its time was left');
      expect(dockerService.pullImages).not.toHaveBeenCalled();
      expect(dockerService.composeApp).not.toHaveBeenCalled();
      // The service may have settled it already; the page must not be told it is updating again.
      expect(sseService.emit).not.toHaveBeenCalled();
    });

    // CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS set below what an update needs refused every update as if
    // it had waited too long for a worker, which was not the reason.
    it('names the setting when the helper budget is too short for any update', async () => {
      process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS = '600';
      try {
        ctx.deadline = AppCommandDeadline.untilReply(Date.now(), 45 * MIN);

        const result = await command.execute(appUrn, {}, ctx);

        expect(result).toMatchObject({ success: false, rolledBack: true });
        expect(result.message).toContain('CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS gives an app command 600 s');
        expect(result.message).toContain('An update needs at least 16 minutes');
        expect(result.message).not.toContain('free worker');
        expect(dockerService.pullImages).not.toHaveBeenCalled();
      } finally {
        delete process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS;
      }
    });

    // 900 s is the work time plus the reserve, so it passed the setting check and then always failed
    // the next one by the seconds the update had spent queued, blaming the worker.
    it('names the setting, not the worker, for a budget of exactly the work time plus the reserve', async () => {
      process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS = '900';
      try {
        ctx.deadline = AppCommandDeadline.untilReply(Date.now() - 2_000, 45 * MIN);

        const result = await command.execute(appUrn, {}, ctx);

        expect(result.message).toContain('CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS gives an app command 900 s');
        expect(result.message).not.toContain('free worker');
      } finally {
        delete process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS;
      }
    });

    it('starts an update whose lowered budget leaves room for a worker to take it', async () => {
      process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS = '1000';
      try {
        ctx.deadline = AppCommandDeadline.untilReply(Date.now() - 2_000, 45 * MIN);

        const result = await command.execute(appUrn, {}, ctx);

        expect(result.message).not.toContain('was not started');
        expect(dockerService.pullImages).toHaveBeenCalled();
      } finally {
        delete process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS;
      }
    });

    it('rolls a stopped app back when the cancel arrived while its files were being replaced', async () => {
      // A stopped app is not started again, so it has no safe point after this step.
      command = new UpdateAppCommand(moduleRef, docker, true, false);
      (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
      (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);
      filesystem.pathExists.mockResolvedValue(true);
      marketplaceService.copyAppFromRepoToInstalled.mockImplementation(async () => {
        controller.abort();
        return undefined as any;
      });

      const result = await command.execute(appUrn, {}, ctx);

      expect(result).toMatchObject({ success: false, cancelled: true, rolledBack: true });
      expect(filesystem.copyDirectory).toHaveBeenCalledWith('/data/snapshots/test-app/snap-1/app-files', '/data/installed/test-app');
      expect(phasesShown()).not.toContain('finalizing');
    });

    it('rolls back when the cancel landed just as the health check passed', async () => {
      dockerService.verifyContainerHealthProbe.mockImplementation(async () => {
        controller.abort();
        return { ok: true, healthy: true, containers: [], message: 'All containers healthy' };
      });

      const result = await command.execute(appUrn, {}, ctx);

      expect(result).toMatchObject({ success: false, cancelled: true, rolledBack: true });
      expect(backupManager.restoreApp).toHaveBeenCalledWith(appUrn, 'test-app-backup.tar.gz', ctx.deadline);
      expect(phasesShown()).not.toContain('finalizing');
    });

    it('rolls back when the time runs out during the backup', async () => {
      ctx.deadline = AppCommandDeadline.after(20 * MIN);
      backupManager.backupApp.mockImplementation(async () => {
        ctx.deadline = AppCommandDeadline.after(9 * MIN);
        return { filename: 'test-app-backup.tar.gz' } as any;
      });

      const result = await command.execute(appUrn, {}, ctx);

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(result.message).toContain('ran out of time');
      // Stopped for the backup, so started again; nothing else was replaced.
      expect(dockerService.composeApp).toHaveBeenLastCalledWith(appUrn, 'up --detach --remove-orphans');
      expect(marketplaceService.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
    });
  });
});
