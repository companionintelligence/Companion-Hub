import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { SSEService } from '@/core/sse/sse.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@runtipi/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { AppLifecycleCommand } from './command';
import { parseComposeJson } from '@runtipi/common/schemas';
import fs from 'node:fs';
import path from 'node:path';

export class InstallAppCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn, form: AppEventFormInput): Promise<{ success: boolean; message: string }> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const _config = this.moduleRef.get(ConfigurationService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const marketplaceService = this.moduleRef.get(MarketplaceService, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const envUtils = this.moduleRef.get(EnvUtils, { strict: false });
    const sseService = this.moduleRef.get(SSEService, { strict: false });

    const emitProgress = (progress: number) => {
      if (sseService) {
        sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'installing', progress }, appUrn);
      }
    };

    try {
      const composeToInstall = await marketplaceService.getDockerComposeJson(appUrn);
      parseComposeJson(composeToInstall.content);
    } catch (err) {
      logger.error(`Error parsing docker-compose.yml for app ${appUrn} from marketplace repository. Are you running the latest version of runtipi?`);
      return this.handleAppError(err, appUrn, 'update_error');
    }

    try {
      emitProgress(5);
      if (process.getuid && process.getgid) {
        logger.info(`Installing app ${appUrn} as User ID: ${process.getuid()}, Group ID: ${process.getgid()}`);
      } else {
        logger.info(`Installing app ${appUrn}. No User ID or Group ID found.`);
      }

      emitProgress(15);
      await marketplaceService.copyAppFromRepoToInstalled(appUrn);

      // Create app.env file
      emitProgress(25);
      logger.info(`Creating app.env file for app ${appUrn}`);
      await appHelpers.generateEnvFile(appUrn, form);

      // Ensure app directory exists before we try to use APP_DATA_DIR
      emitProgress(30);
      await this.ensureAppDir(appUrn, form);

      // Copy data dir
      emitProgress(35);
      const appEnv = await appFilesManager.getAppEnv(appUrn);
      const envMap = envUtils.envStringToMap(appEnv.content);

      // Ensure APP_DATA_DIR exists on the host before docker-compose tries to mount it
      // We need to create it using the container path since we're inside the container
      // The container path /app-data maps to the host path via the volume mount
      const { appStoreId, appName } = extractAppUrn(appUrn);
      const containerAppDataPath = `/app-data/${appStoreId}/${appName}`;
      const hostAppDataDir = envMap.get('APP_DATA_DIR');

      if (hostAppDataDir) {
        logger.info(`Ensuring APP_DATA_DIR exists (host: ${hostAppDataDir}, container: ${containerAppDataPath})`);
        try {
          // Create using container path - this will create on host via volume mount
          await fs.promises.mkdir(containerAppDataPath, { recursive: true });
          logger.debug(`APP_DATA_DIR created/verified via container path: ${containerAppDataPath}`);
        } catch (error) {
          logger.warn(`Failed to create APP_DATA_DIR via container path ${containerAppDataPath}: ${error}`);
          // Try to create subdirectories that might be needed
          try {
            const dataSubdirs = ['data', 'redis', 'postgres', 'db'];
            for (const subdir of dataSubdirs) {
              const subdirPath = path.join(containerAppDataPath, subdir);
              await fs.promises.mkdir(subdirPath, { recursive: true }).catch(() => {
                // Ignore errors for subdirectories
              });
            }
          } catch (_subdirError) {
            // Ignore subdirectory creation errors
          }
        }
      }

      logger.info(`Copying data dir for app ${appUrn}`);
      await marketplaceService.copyDataDir(appUrn, envMap);

      emitProgress(45);

      emitProgress(50);
      try {
        await dockerService.composeApp(appUrn, 'down --rmi all --remove-orphans');
      } catch (_) {
        logger.warn(`No prior containers to remove for app ${appUrn}`);
      }

      const appInfo = await appFilesManager.getInstalledAppInfo(appUrn);

      if (!appInfo) {
        return { success: true, message: 'App config not found. Skipping...' };
      }

      // run docker-compose up
      const forcePull = appInfo.force_pull ?? false;

      if (form.skipRun) {
        logger.info(`Skipping docker-compose up for app ${appUrn} as per request`);
        emitProgress(99);
        return { success: true, message: `App ${appUrn} installed successfully (skipped run)` };
      }

      emitProgress(60);
      await dockerService.composeApp(appUrn, `up --detach --force-recreate --remove-orphans ${forcePull ? '--pull always' : ''}`);
      emitProgress(85);
      await appFilesManager.setAppDataDirPermissions(appUrn);

      // Create Cloudflare Tunnel route if exposedLocal is enabled (app is published to internet)
      // This part now uses CloudflareClientService to SYNC state with CI-Cloud
      // CI-Cloud will handle the actual DNS and Tunnel updates via the trigger in AppLifecycleService
      logger.info(`[Cloudflare] Syncing state for ${appUrn}, exposedLocal: ${form.exposedLocal}`);
      try {
        const cloudflareService = this.moduleRef.get(CloudflareClientService, { strict: false });
        if (cloudflareService) {
          logger.info('[Cloudflare] CloudflareClientService available. State sync will be triggered by AppLifecycleService.');
        } else {
          logger.warn(`[Cloudflare] CloudflareClientService not available for ${appUrn}`);
        }
      } catch (error) {
        logger.error(`[Cloudflare] Exception syncing state for ${appUrn}: ${error}`);
        if (error instanceof Error) {
          logger.error(`[Cloudflare] Error stack: ${error.stack}`);
        }
        // Don't fail the installation if Cloudflare sync fails
      }

      emitProgress(99);
      return { success: true, message: `App ${appUrn} installed successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'install');
    }
  }
}
