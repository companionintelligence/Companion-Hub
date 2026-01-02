import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { CloudflareTunnelService } from '@/modules/cloudflare/cloudflare-tunnel.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { DockerService } from '@/modules/docker/docker.service';
import type { AppUrn } from '@runtipi/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { AppLifecycleCommand } from './command';

export class UninstallAppCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn): Promise<{ success: boolean; message: string }> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });

    try {
      logger.info(`Uninstalling app ${appUrn}`);

      try {
        await dockerService.composeApp(appUrn, 'down --remove-orphans -v --rmi all');
        logger.info(`Successfully cleaned up all Docker resources for ${appUrn}`);
      } catch (err) {
        logger.warn('Error taking down app', appUrn, err);
      }

      // Delete Cloudflare Tunnel route if enabled and app was exposed locally
      try {
        const cloudflareService = this.moduleRef.get(CloudflareTunnelService, { strict: false });
        if (cloudflareService?.isEnabled()) {
          // Get the app to retrieve the localSubdomain and exposedLocal status
          const appsRepository = this.moduleRef.get(AppsRepository, { strict: false });
          const app = await appsRepository?.getAppByUrn(appUrn);
          
          // Only delete Cloudflare route if the app was exposed locally
          if (app?.exposedLocal) {
            // Use the same subdomain logic: app.localSubdomain ?? `${appName}-${appStoreId}`
            const { appName, appStoreId } = extractAppUrn(appUrn);
            const subdomain = app.localSubdomain || `${appName}-${appStoreId}`;
            
            // Get organization info if available (for organization-specific tunnel)
            const registrationService = this.moduleRef.get(RegistrationService, { strict: false });
            const orgInfo = await registrationService?.getOrganizationInfo();
            const organizationInfo = orgInfo
              ? { tunnelId: orgInfo.tunnelId, domain: orgInfo.domain }
              : null;
            
            // deleteAppRoute handles both organization and default tunnels
            await cloudflareService.deleteAppRoute(subdomain, organizationInfo);
          }
        }
      } catch (error) {
        logger.warn(`Failed to delete Cloudflare Tunnel route for ${appUrn}: ${error}`);
        // Don't fail the uninstallation if Cloudflare route deletion fails
      }

      await appFilesManager.deleteAppFolder(appUrn);
      await appFilesManager.deleteAppDataDir(appUrn);

      return { success: true, message: `App ${appUrn} uninstalled successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'uninstall');
    }
  }
}
