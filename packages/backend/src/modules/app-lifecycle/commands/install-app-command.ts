import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { SSEService } from '@/core/sse/sse.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { CloudflareTunnelService } from '@/modules/cloudflare/cloudflare-tunnel.service';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { RegistrationService } from '@/modules/registration/registration.service';
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
    const config = this.moduleRef.get(ConfigurationService, { strict: false });
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
      // Routes directly to the app's host port - makes app available at subdomain.companionintel.com
      // Or subdomain.orgDomain.companionintel.com if organization is registered
      logger.info(`[Cloudflare] Checking route creation for ${appUrn}, exposedLocal: ${form.exposedLocal}`);
      try {
        const cloudflareService = this.moduleRef.get(CloudflareTunnelService, { strict: false });
        if (!cloudflareService) {
          logger.warn(`[Cloudflare] CloudflareTunnelService not available for ${appUrn}`);
        } else {
          const isEnabled = cloudflareService.isEnabled();
          logger.info(`[Cloudflare] Service available for ${appUrn}, enabled: ${isEnabled}, exposedLocal: ${form.exposedLocal}`);
          
          if (isEnabled) {
            const { appName, appStoreId } = extractAppUrn(appUrn);

            // When exposedLocal is enabled, create a route directly to the app's exposed port
            // This publishes the app to the internet via Cloudflare Tunnel -> App Container
            if (form.exposedLocal) {
              const subdomain = form.localSubdomain ? form.localSubdomain : `${appName}-${appStoreId}`;

              // Always use base domain (companionintel.com) for app routes, not organization domain
              // Apps should be accessible at appname.companionintel.com, not appname.orgname.companionintel.com
              emitProgress(90);
              const domain = 'companionintel.com';
              const hostname = `${subdomain}.${domain}`;
              
              // Get the app's port from form or appInfo
              const appPort = form.port || appInfo.port;
              if (!appPort) {
                logger.error(`[Cloudflare] Cannot create route for ${appUrn} - no port specified`);
              } else {
                logger.info(`[Cloudflare] Creating route and DNS for ${appUrn} -> localhost:${appPort} (hostname: ${hostname})`);
                // Don't pass organizationInfo - always use base domain
                const routeCreated = await cloudflareService.createAppRoute(subdomain, appPort, null);
                if (routeCreated) {
                  logger.info(`[Cloudflare] ✅ Successfully created route and DNS for ${hostname}`);
                } else {
                  logger.error(`[Cloudflare] ❌ Failed to create route for ${hostname}. Check Cloudflare service logs for details.`);
                }
              }
            } else {
              logger.info(`[Cloudflare] Skipping route creation for ${appUrn} - exposedLocal is false`);
            }
          } else {
            logger.warn(`[Cloudflare] Service is not enabled. Check CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_TUNNEL_ID environment variables.`);
          }
        }
      } catch (error) {
        logger.error(`[Cloudflare] Exception creating route for ${appUrn}: ${error}`);
        if (error instanceof Error) {
          logger.error(`[Cloudflare] Error stack: ${error.stack}`);
        }
        // Don't fail the installation if Cloudflare route creation fails
      }

      emitProgress(99);
      return { success: true, message: `App ${appUrn} installed successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'install');
    }
  }
}
