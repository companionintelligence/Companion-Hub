import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
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
import { extractComposeImages } from './install-app-command';
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
      return this.handleAppError(err, appUrn, 'update_error');
    }

    let backupFile: string | undefined;
    let snapshotResult: Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>> | undefined;
    let previousEnv: string | undefined;

    // How far the update got, so a failure knows how much there is to undo.
    let stoppedForBackup = false;
    let replacingFiles = false;
    // Set once the health-probe rollback below has already dealt with the previous version.
    let probeRollbackHandled = false;
    let probeRollbackRecovered = false;

    try {
      await this.assertMarketplaceEntitlement(appUrn, 'update');

      // ⚠ PULL BEFORE TOUCHING THE RUNNING APP. The pull is the step that most often fails (no
      // network, registry down, a tag that does not exist) and the slowest, so doing it after the
      // old version was stopped and torn down turned every such failure into downtime with the new
      // files already on disk. Nothing is stopped, removed or replaced until the images are here.
      logger.info(`Pulling images for ${appUrn} before stopping the current version`);
      await dockerService.pullImages(extractComposeImages(composeToInstall.content), { forcePull: true });

      if (this.performBackup) {
        await dockerService.composeApp(appUrn, 'stop');
        stoppedForBackup = true;
        const backupRes = await backupManager.backupApp(appUrn);
        backupFile = backupRes?.filename;
        await this.applyBackupRetention(appUrn);
      }

      // The data is already in the backup when there is one; copying it again here is a second full
      // copy of the app's data folder that nothing reads. The installed files are always snapshotted:
      // they are what a rollback puts back.
      snapshotResult = await dockerService.createPreUpdateVolumeSnapshot(appUrn, { includeData: !backupFile });
      previousEnv = (await appFilesManager.getAppEnv(appUrn))?.content;

      logger.info(`Updating app ${appUrn}`);
      // From here on the previous version is being taken apart.
      replacingFiles = true;
      await this.ensureAppDir(appUrn, form);
      await appHelpers.generateEnvFile(appUrn, form);

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
        await dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');

        const probeResult = await dockerService.verifyContainerHealthProbe(appUrn, { maxAttempts: 5, delayMs: 2000 });
        if (!probeResult.healthy) {
          logger.error(`Post-update health check failed for app ${appUrn}: ${probeResult.message}. Initiating auto-rollback...`);
          probeRollbackHandled = true;

          // However the restore below goes, we must not leave the app torn down: `down` is
          // immediately followed by an unconditional `up` on whatever files/data are on disk
          // at that point, so a restore failure degrades to "recreate the just-updated version"
          // rather than "stay offline". Restore failures are logged, not rethrown, for the
          // same reason.
          try {
            await dockerService.composeApp(appUrn, 'down --remove-orphans');

            if (backupFile) {
              try {
                await backupManager.restoreApp(appUrn, backupFile);
                logger.info(`Restored ${appUrn} app files and data from backup ${backupFile}`);
              } catch (restoreErr) {
                logger.error(`Failed to restore ${appUrn} from backup ${backupFile}: ${restoreErr}`);
              }
            } else if (snapshotResult?.snapshotPath || snapshotResult?.appFilesSnapshotPath) {
              try {
                const { appDataDir, appInstalledDir } = appFilesManager.getAppPaths(appUrn);
                const filesystem = this.moduleRef.get(FilesystemService, { strict: false });
                if (filesystem && snapshotResult.snapshotPath && (await filesystem.pathExists(snapshotResult.snapshotPath))) {
                  await filesystem.removeDirectory(appDataDir);
                  await filesystem.copyDirectory(snapshotResult.snapshotPath, appDataDir);
                }
                if (filesystem && snapshotResult.appFilesSnapshotPath && (await filesystem.pathExists(snapshotResult.appFilesSnapshotPath))) {
                  await filesystem.removeDirectory(appInstalledDir);
                  await filesystem.copyDirectory(snapshotResult.appFilesSnapshotPath, appInstalledDir);
                }
                logger.info(`Restored ${appUrn} app files and data from snapshot ${snapshotResult.snapshotId}`);
              } catch (snapshotErr) {
                logger.error(`Failed to restore ${appUrn} from volume snapshot: ${snapshotErr}`);
              }
            } else {
              logger.warn(`No backup or volume snapshot available to roll back ${appUrn}; recreating the current containers instead`);
            }

            await dockerService.composeApp(appUrn, 'pull');
            await dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');
            probeRollbackRecovered = true;
            logger.info(`Auto-rollback recovery step completed for ${appUrn}`);
          } catch (rollbackErr) {
            logger.error(`Failed to bring ${appUrn} back up after auto-rollback: ${rollbackErr}`);
          }

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
      const rolledBack = probeRollbackHandled
        ? probeRollbackRecovered
        : await this.restorePreviousVersion(appUrn, { stoppedForBackup, replacingFiles, snapshotResult, previousEnv });

      if (rolledBack) {
        await this.discardSnapshot(snapshotResult);
      }

      return { ...(await this.handleAppError(err, appUrn, 'update_error')), rolledBack };
    }
  }

  /**
   * After a failed update, put the app back as it was and say whether that worked.
   *
   * Before the files were replaced there is little to undo: the images are pulled and nothing else
   * has changed, except that a backup stops the app. After, the previous installed files and
   * app.env come back from the snapshot taken first, and a previously running app is started on
   * them. When any of that cannot be done the snapshot is left where it is, and its path is logged
   * for a manual restore.
   *
   * @returns whether the previous version is back in place and, if it was running, started
   */
  private async restorePreviousVersion(
    appUrn: AppUrn,
    state: {
      stoppedForBackup: boolean;
      replacingFiles: boolean;
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

      await dockerService.composeApp(appUrn, 'down --remove-orphans').catch(() => undefined);

      const snapshotPath = state.snapshotResult?.appFilesSnapshotPath;
      const filesystem = this.moduleRef.get(FilesystemService, { strict: false });

      if (!snapshotPath || !filesystem || !(await filesystem.pathExists(snapshotPath))) {
        throw new Error('there is no snapshot of the previous app files to restore');
      }

      const { appInstalledDir } = appFilesManager.getAppPaths(appUrn);

      if (!(await filesystem.removeDirectory(appInstalledDir)) || !(await filesystem.copyDirectory(snapshotPath, appInstalledDir))) {
        throw new Error(`could not copy the previous app files back from ${snapshotPath}`);
      }

      if (state.previousEnv) {
        await appFilesManager.writeAppEnv(appUrn, state.previousEnv);
      }

      if (this.wasRunning) {
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
