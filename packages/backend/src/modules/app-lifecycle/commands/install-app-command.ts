import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { CloudflareTunnelService } from '@/modules/cloudflare/cloudflare-tunnel.service';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@runtipi/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { AppLifecycleCommand } from './command';
import { parseComposeJson } from '@runtipi/common/schemas';

export class InstallAppCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn, form: AppEventFormInput): Promise<{ success: boolean; message: string }> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const config = this.moduleRef.get(ConfigurationService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const marketplaceService = this.moduleRef.get(MarketplaceService, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const envUtils = this.moduleRef.get(EnvUtils, { strict: false });

    try {
      const composeToInstall = await marketplaceService.getDockerComposeJson(appUrn);
      parseComposeJson(composeToInstall.content);
    } catch (err) {
      logger.error(`Error parsing docker-compose.yml for app ${appUrn} from marketplace repository. Are you running the latest version of runtipi?`);
      return this.handleAppError(err, appUrn, 'update_error');
    }

    try {
      if (process.getuid && process.getgid) {
        logger.info(`Installing app ${appUrn} as User ID: ${process.getuid()}, Group ID: ${process.getgid()}`);
      } else {
        logger.info(`Installing app ${appUrn}. No User ID or Group ID found.`);
      }

      await marketplaceService.copyAppFromRepoToInstalled(appUrn);

      // Create app.env file
      logger.info(`Creating app.env file for app ${appUrn}`);
      await appHelpers.generateEnvFile(appUrn, form);

      // Copy data dir
      const appEnv = await appFilesManager.getAppEnv(appUrn);
      const envMap = envUtils.envStringToMap(appEnv.content);

      logger.info(`Copying data dir for app ${appUrn}`);
      await marketplaceService.copyDataDir(appUrn, envMap);

      await this.ensureAppDir(appUrn, form);

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
        return { success: true, message: `App ${appUrn} installed successfully (skipped run)` };
      }

      await dockerService.composeApp(appUrn, `up --detach --force-recreate --remove-orphans ${forcePull ? '--pull always' : ''}`);
      await appFilesManager.setAppDataDirPermissions(appUrn);

      // Create Cloudflare Tunnel route if enabled and app is published to internet
      // Routes directly to the app's port - no Traefik middleman
      try {
        const cloudflareService = this.moduleRef.get(CloudflareTunnelService, { strict: false });
        if (!cloudflareService) {
          logger.debug(`CloudflareTunnelService not available for ${appUrn}`);
        } else if (!cloudflareService.isEnabled()) {
          logger.debug(`Cloudflare Tunnel integration is not enabled for ${appUrn}`);
        } else {
          const { appName, appStoreId } = extractAppUrn(appUrn);
          const { isProduction } = config?.getConfig() || { isProduction: false };
          
          // In production, when exposedLocal is enabled, create a direct route to the app's port
          if (form.exposedLocal && isProduction && form.port) {
            const subdomain = form.localSubdomain ? form.localSubdomain : `${appName}-${appStoreId}`;
            
            logger.info(`Creating Cloudflare Tunnel route for ${appUrn} -> localhost:${form.port} (subdomain: ${subdomain})`);
            await cloudflareService.createAppRoute(subdomain, form.port);
          }
        }
      } catch (error) {
        logger.warn(`Failed to create Cloudflare Tunnel route for ${appUrn}: ${error}`);
        // Don't fail the installation if Cloudflare route creation fails
      }

      return { success: true, message: `App ${appUrn} installed successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'install');
    }
  }
}
