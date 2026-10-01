import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DockerService } from '@/modules/docker/docker.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import type Dockerode from 'dockerode';
import { AppLifecycleCommand } from './command';
import { parseComposeJson } from '@ci-hub/common/schemas';

export class UpdateAppCommand extends AppLifecycleCommand {
  /**
   * @param performBackup back the app up (which stops it) before replacing its files
   * @param wasRunning whether the app was running when the update was requested. A stopped app is
   *   updated and left stopped; only a running one is started again afterwards. Defaults to `true`,
   *   the behaviour before the flag existed, for a queued message that predates it.
   */
  constructor(
    moduleRef: ModuleRef,
    docker: Dockerode,
    private readonly performBackup: boolean = true,
    private readonly wasRunning: boolean = true,
  ) {
    super(moduleRef, docker);
  }

  public async execute(appUrn: AppUrn, form: AppEventFormInput) {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const marketplaceService = this.moduleRef.get(MarketplaceService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const backupManager = this.moduleRef.get(BackupManager, { strict: false });

    let composeToInstall: Awaited<ReturnType<MarketplaceService['getDockerComposeJson']>>;
    try {
      composeToInstall = await marketplaceService.getDockerComposeJson(appUrn);
      parseComposeJson(composeToInstall.content);
    } catch (err) {
      logger.error(`Error parsing docker-compose.yml for app ${appUrn} from marketplace repository. Are you running the latest version of CI Hub?`);
      // Nothing has been touched: the running app is exactly as it was.
      return { ...(await this.handleAppError(err, appUrn, 'update_error')), rolledBack: true };
    }

    let backupFile: string | undefined;
    let snapshotResult: Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>> | undefined;
    let previousEnv: string | undefined;

    // How far the update got, so a failure knows how much there is to undo. Each is set BEFORE the step
    // it describes, not after: a step that fails half-way has still done part of its work.
    let stoppedForBackup = false;
    let replacingFiles = false;
    let tookDown = false;
    let startedNewVersion = false;

    try {
      await this.assertMarketplaceEntitlement(appUrn, 'update');

      // ⚠ PULL BEFORE TOUCHING THE RUNNING APP. The pull is the step that most often fails (no
      // network, registry down, a tag that does not exist) and the slowest, so doing it after the
      // old version was stopped and torn down turned every such failure into downtime with the new
      // files already on disk. Nothing is stopped, removed or replaced until the images are here.
      logger.info(`Pulling images for ${appUrn} before stopping the current version`);
      await dockerService.pullImages(this.imagesToPull(composeToInstall.content), { forcePull: true });

      if (this.performBackup) {
        stoppedForBackup = true;
        await dockerService.composeApp(appUrn, 'stop');
        const backupRes = await backupManager.backupApp(appUrn);
        backupFile = backupRes?.filename;
        await this.applyBackupRetention(appUrn);
      }

      // The data is already in the backup when there is one; copying it again here is a second full
      // copy of the app's data folder that nothing reads. The installed files are always snapshotted:
      // they are what a rollback puts back.
      snapshotResult = await dockerService.createPreUpdateVolumeSnapshot(appUrn, { includeData: !backupFile });

      // An update that cannot be undone is not started. Nothing has been changed yet, so refusing here
      // costs nothing; going on would put a failed or partial snapshot in charge of the rollback.
      if (!snapshotResult?.success) {
        throw new Error(`Could not snapshot ${appUrn} before updating it (${snapshotResult?.error ?? 'unknown error'}); the update was not started`);
      }
      previousEnv = (await appFilesManager.getAppEnv(appUrn))?.content;

      logger.info(`Updating app ${appUrn}`);
      // From here on the previous files and app.env are being replaced.
      replacingFiles = true;
      await this.ensureAppDir(appUrn, form);
      await appHelpers.generateEnvFile(appUrn, form);

      tookDown = true;
      try {
        await dockerService.composeApp(appUrn, 'down --rmi local --remove-orphans');
      } catch (_) {
        logger.warn(`App ${appUrn} has likely a broken docker-compose.yml file. Continuing with update...`);
      }

      if (!(await appFilesManager.deleteAppFolder(appUrn))) {
        throw new Error(`Could not remove the previous files of ${appUrn}`);
      }
      await marketplaceService.copyAppFromRepoToInstalled(appUrn);

      await this.ensureAppDir(appUrn, form);

      // An app that was stopped when the update began is updated and left stopped. Starting it here,
      // as every update did, switched on something its owner had switched off.
      if (this.wasRunning) {
        await dockerService.composeApp(appUrn, 'pull');
        startedNewVersion = true;
        await dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');

        const probeResult = await dockerService.verifyContainerHealthProbe(appUrn, { maxAttempts: 5, delayMs: 2000 });
        if (!probeResult.healthy) {
          logger.error(`Post-update health check failed for app ${appUrn}: ${probeResult.message}. Initiating auto-rollback...`);
          throw new Error(`Update failed health probe: ${probeResult.message}`);
        }
      }

      // The update just replaced the app's config.json, which is where the wake endpoint
      // and port come from. Without re-registering, the Hub would keep POSTing to the URL
      // captured at install time — so a manifest that moves the endpoint would never take
      // effect on an app that is already installed.
      try {
        const agentNotifyService = this.moduleRef.get(AgentNotifyService, { strict: false });
        const target = await agentNotifyService?.resolveWebhookTarget(appUrn);
        if (target) {
          agentNotifyService.registerWebhook(appUrn, target.url, target.token);
        }
      } catch (hookErr) {
        logger.warn(`Failed to refresh the agent webhook for ${appUrn}: ${hookErr}`);
      }

      await this.discardSnapshot(snapshotResult);

      return { success: true, message: `App ${appUrn} updated successfully` };
    } catch (err) {
      // Once the new version has been started it may have migrated the data, so putting the old files
      // back is not enough: the data comes back too. Before that, the old data was never touched.
      const rolledBack = startedNewVersion
        ? await this.rollBackStartedVersion(appUrn, { backupFile, snapshotResult })
        : await this.restorePreviousVersion(appUrn, { stoppedForBackup, replacingFiles, tookDown, snapshotResult, previousEnv });

      // The snapshot is the last copy of the previous version when a rollback has not worked. It goes
      // only once the previous version is demonstrably back.
      if (rolledBack) {
        await this.discardSnapshot(snapshotResult);
      }

      return { ...(await this.handleAppError(err, appUrn, 'update_error')), rolledBack };
    }
  }

  /**
   * The images the new version needs, as `compose pull` would resolve them: with the per-architecture
   * overrides applied, so the pull asks for the image this machine will actually run.
   */
  private imagesToPull(composeContent: unknown): string[] {
    const configService = this.moduleRef.get(ConfigurationService, { strict: false });
    const { services, overrides } = parseComposeJson(composeContent);
    const merged = mergeArchitectureOverrides(services, overrides, configService?.get('architecture'));

    return [...new Set(merged.map((service) => service.image?.trim()).filter((image): image is string => Boolean(image)))];
  }

  /**
   * Undo an update whose new version was already started: bring everything down, put back the
   * previous files AND data (from the backup if one was taken, otherwise from the snapshot), and
   * start the previous version.
   *
   * ⚠ "BACK UP" IS NOT "ROLLED BACK". The previous version is started whatever happened to the restore,
   * so the app is never left torn down, but the return value is true only when the restore really
   * worked. Reporting a rollback that did nothing would delete the snapshot, the only remaining copy.
   *
   * @returns whether the previous files and data are back in place and the previous version was started
   */
  private async rollBackStartedVersion(
    appUrn: AppUrn,
    state: { backupFile: string | undefined; snapshotResult: Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>> | undefined },
  ): Promise<boolean> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const backupManager = this.moduleRef.get(BackupManager, { strict: false });

    let restored = false;

    try {
      await dockerService.composeApp(appUrn, 'down --remove-orphans');

      if (state.backupFile) {
        try {
          await backupManager.restoreApp(appUrn, state.backupFile);
          restored = true;
          logger.info(`Restored ${appUrn} app files and data from backup ${state.backupFile}`);
        } catch (restoreErr) {
          logger.error(`Failed to restore ${appUrn} from backup ${state.backupFile}: ${restoreErr}. The backup file has been kept.`);
        }
      } else if (state.snapshotResult?.snapshotPath || state.snapshotResult?.appFilesSnapshotPath) {
        restored = await this.restoreFromSnapshot(appUrn, state.snapshotResult);
      } else {
        logger.warn(`No backup or volume snapshot available to roll back ${appUrn}; recreating the current containers instead`);
      }

      await dockerService.composeApp(appUrn, 'pull');
      await dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');
      logger.info(`Auto-rollback recovery step completed for ${appUrn} (data and files ${restored ? 'restored' : 'NOT restored'})`);

      return restored;
    } catch (rollbackErr) {
      logger.error(`Failed to bring ${appUrn} back up after auto-rollback: ${rollbackErr}`);
      return false;
    }
  }

  /** Copy the snapshot's data folder and installed files back, reporting whether every copy worked. */
  private async restoreFromSnapshot(
    appUrn: AppUrn,
    snapshot: NonNullable<Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>>>,
  ): Promise<boolean> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const filesystem = this.moduleRef.get(FilesystemService, { strict: false });

    try {
      const { appDataDir, appInstalledDir } = appFilesManager.getAppPaths(appUrn);
      let ok = true;

      // `removeDirectory` and `copyDirectory` report failure (ENOSPC, EACCES) by returning false, not by throwing.
      if (filesystem && snapshot.snapshotPath && (await filesystem.pathExists(snapshot.snapshotPath))) {
        const removed = await filesystem.removeDirectory(appDataDir);
        const copied = await filesystem.copyDirectory(snapshot.snapshotPath, appDataDir);
        ok = ok && removed !== false && copied !== false;
      }

      if (filesystem && snapshot.appFilesSnapshotPath && (await filesystem.pathExists(snapshot.appFilesSnapshotPath))) {
        const removed = await filesystem.removeDirectory(appInstalledDir);
        const copied = await filesystem.copyDirectory(snapshot.appFilesSnapshotPath, appInstalledDir);
        ok = ok && removed !== false && copied !== false;
      }

      if (ok) {
        logger.info(`Restored ${appUrn} app files and data from snapshot ${snapshot.snapshotId}`);
      } else {
        logger.error(
          `Could not restore all of ${appUrn} from snapshot ${snapshot.snapshotId}; it has been kept at ${snapshot.snapshotBaseDir ?? 'its snapshot folder'}`,
        );
      }

      return ok;
    } catch (snapshotErr) {
      logger.error(`Failed to restore ${appUrn} from volume snapshot: ${snapshotErr}`);
      return false;
    }
  }

  /**
   * After a failed update that never started the new version, put the app back as it was and say
   * whether that worked.
   *
   * Before the files were replaced there is little to undo: the images are pulled and nothing else
   * has changed, except that a backup stops the app. After, the previous installed files and
   * app.env come back from the snapshot taken first. The app is taken down and started again only
   * if the update actually took it down (or the backup stopped it): a failure while the old version
   * was still running must not turn into downtime. When anything cannot be done the snapshot is left
   * where it is, and its path is logged for a manual restore.
   *
   * @returns whether the previous version is back in place and, if it was running, running
   */
  private async restorePreviousVersion(
    appUrn: AppUrn,
    state: {
      stoppedForBackup: boolean;
      replacingFiles: boolean;
      tookDown: boolean;
      snapshotResult: Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>> | undefined;
      previousEnv: string | undefined;
    },
  ): Promise<boolean> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });

    try {
      if (!state.replacingFiles) {
        if (state.stoppedForBackup && this.wasRunning) {
          await dockerService.composeApp(appUrn, 'up --detach --remove-orphans');
        }

        return true;
      }

      // Checked BEFORE any container is touched: a rollback that cannot restore must not also take
      // down an app that is still running.
      const snapshotPath = state.snapshotResult?.appFilesSnapshotPath;
      const filesystem = this.moduleRef.get(FilesystemService, { strict: false });

      if (!snapshotPath || !filesystem || !(await filesystem.pathExists(snapshotPath))) {
        throw new Error('there is no snapshot of the previous app files to restore');
      }

      if (state.tookDown) {
        await dockerService.composeApp(appUrn, 'down --remove-orphans').catch(() => undefined);
      }

      const { appInstalledDir } = appFilesManager.getAppPaths(appUrn);

      if (
        (await filesystem.removeDirectory(appInstalledDir)) === false ||
        (await filesystem.copyDirectory(snapshotPath, appInstalledDir)) === false
      ) {
        throw new Error(`could not copy the previous app files back from ${snapshotPath}`);
      }

      if (state.previousEnv) {
        await appFilesManager.writeAppEnv(appUrn, state.previousEnv);
      }

      if (this.wasRunning && (state.tookDown || state.stoppedForBackup)) {
        await dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');
      }

      logger.info(`Restored the previous version of ${appUrn} after a failed update`);
      return true;
    } catch (restoreErr) {
      const where = state.snapshotResult?.snapshotBaseDir ?? state.snapshotResult?.appFilesSnapshotPath;
      logger.error(
        `Could not restore the previous version of ${appUrn} after a failed update: ${restoreErr}.${where ? ` The snapshot taken before the update is kept at ${where}.` : ''}`,
      );
      return false;
    }
  }

  /** Apply the app's backup limit (or the global one) right after the update's backup, as a manual backup does. */
  private async applyBackupRetention(appUrn: AppUrn): Promise<void> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });

    try {
      const backupManager = this.moduleRef.get(BackupManager, { strict: false });
      const appsRepository = this.moduleRef.get(AppsRepository, { strict: false });
      const config = this.moduleRef.get(ConfigurationService, { strict: false });

      const app = await appsRepository.getAppByUrn(appUrn);
      const maxBackups = app?.maxBackups ?? config.get('userSettings').maxBackups;

      await backupManager.cleanupOldBackups(appUrn, maxBackups);
    } catch (err) {
      // The backup itself succeeded; failing the update over a failed tidy-up would help nobody.
      logger.warn(`Could not apply the backup limit to ${appUrn} after its update backup: ${err}`);
    }
  }

  /** The snapshot exists to undo a failed update; once there is nothing to undo it is a full copy of the app's files taking disk for good. */
  private async discardSnapshot(snapshotResult: Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>> | undefined): Promise<void> {
    if (!snapshotResult?.snapshotBaseDir) {
      return;
    }

    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const filesystem = this.moduleRef.get(FilesystemService, { strict: false });

    try {
      await filesystem?.removeDirectory(snapshotResult.snapshotBaseDir);
    } catch (err) {
      logger.warn(`Could not remove the pre-update snapshot ${snapshotResult.snapshotBaseDir}: ${err}`);
    }
  }
}
