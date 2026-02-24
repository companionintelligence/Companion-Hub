import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { DockerService } from '@/modules/docker/docker.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import type { AppUrn } from '@runtipi/common/types';
import { AppLifecycleCommand } from './command';

export class UninstallAppCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn): Promise<{ success: boolean; message: string }> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });

    try {
      logger.info(`Uninstalling app ${appUrn}`);

      // Release allocated ports
      try {
        const portManager = this.moduleRef.get(PortManagerService, { strict: false });
        if (portManager) {
          const released = await portManager.releaseAll(appUrn);
          if (released > 0) {
            logger.info(`Released ${released} port allocation(s) for ${appUrn}`);
          }
        }
      } catch (err) {
        logger.warn(`Failed to release ports for ${appUrn}: ${err}`);
      }

      try {
        await dockerService.composeApp(appUrn, 'down --remove-orphans -v --rmi local');
        logger.info(`Successfully cleaned up all Docker resources for ${appUrn}`);
      } catch (err) {
        logger.warn('Error taking down app', appUrn, err);
      }

      // Sync Cloudflare state (app removal will be reflected)
      try {
        const cloudflareService = this.moduleRef.get(CloudflareClientService, { strict: false });
        if (cloudflareService) {
          // Ideally we trigger a full sync here which will notice the app is gone
          // For now, we just log.
          logger.info(`[Cloudflare] App ${appUrn} removed. Ideally triggering state sync now.`);
        }
      } catch (error) {
        logger.warn(`Failed to sync Cloudflare state for ${appUrn}: ${error}`);
        // Don't fail the uninstallation if Cloudflare sync fails
      }

      await appFilesManager.deleteAppFolder(appUrn);
      await appFilesManager.deleteAppDataDir(appUrn);

      return { success: true, message: `App ${appUrn} uninstalled successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'uninstall');
    }
  }
}
