import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
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
  constructor(
    moduleRef: ModuleRef,
    docker: Dockerode,
    private readonly performBackup: boolean = true,
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

    try {
      const composeToInstall = await marketplaceService.getDockerComposeJson(appUrn);
      parseComposeJson(composeToInstall.content);
    } catch (err) {
      logger.error(`Error parsing docker-compose.yml for app ${appUrn} from marketplace repository. Are you running the latest version of CI Hub?`);
      return this.handleAppError(err, appUrn, 'update_error');
    }

    let backupFile: string | undefined;
    let snapshotResult: Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>> | undefined;

    try {
      await this.assertMarketplaceEntitlement(appUrn, 'update');
      if (this.performBackup) {
        await dockerService.composeApp(appUrn, 'stop');
        const backupRes = await backupManager.backupApp(appUrn);
        backupFile = backupRes?.filename;
      }

      snapshotResult = await dockerService.createPreUpdateVolumeSnapshot(appUrn);

      logger.info(`Updating app ${appUrn}`);
      await this.ensureAppDir(appUrn, form);
      await appHelpers.generateEnvFile(appUrn, form);

      try {
        await dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');
        await dockerService.composeApp(appUrn, 'down --rmi local --remove-orphans');
      } catch (_) {
        logger.warn(`App ${appUrn} has likely a broken docker-compose.yml file. Continuing with update...`);
      }

      await appFilesManager.deleteAppFolder(appUrn);
      await marketplaceService.copyAppFromRepoToInstalled(appUrn);

      await this.ensureAppDir(appUrn, form);

      await dockerService.composeApp(appUrn, 'pull');
      await dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');

      const probeResult = await dockerService.verifyContainerHealthProbe(appUrn, { maxAttempts: 5, delayMs: 2000 });
      if (!probeResult.healthy) {
        logger.error(`Post-update health check failed for app ${appUrn}: ${probeResult.message}. Initiating auto-rollback...`);

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
          logger.info(`Auto-rollback recovery step completed for ${appUrn}`);
        } catch (rollbackErr) {
          logger.error(`Failed to bring ${appUrn} back up after auto-rollback: ${rollbackErr}`);
        }

        throw new Error(`Update failed health probe: ${probeResult.message}`);
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

      return { success: true, message: `App ${appUrn} updated successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'update_error');
    }
  }
}
