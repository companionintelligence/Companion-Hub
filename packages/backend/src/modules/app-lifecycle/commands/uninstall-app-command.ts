import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import type { AppUrn } from '@ci-hub/common/types';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { AppLifecycleCommand } from './command';
import { handOverKeptImages, sortImagesByOtherApps } from './pull-app-images';
import { describeLeftovers, removeAppDataWithPrivilegedFallback } from './remove-app-data';

export class UninstallAppCommand extends AppLifecycleCommand {
  constructor(
    moduleRef: ConstructorParameters<typeof AppLifecycleCommand>[0],
    docker: ConstructorParameters<typeof AppLifecycleCommand>[1],
    private readonly deleteAllData = true,
  ) {
    super(moduleRef, docker);
  }

  public async execute(appUrn: AppUrn): Promise<{ success: boolean; message: string; warningCode?: string; warningDetail?: string }> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });

    try {
      logger.info(`Uninstalling app ${appUrn}`);

      const config = await appFilesManager.getInstalledAppInfo(appUrn);
      const isPortExpose = config && isPortExposeApp(config);

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
        if (!isPortExpose) {
          // `local` removes only the images compose built for this app; the pulled ones are removed by ID below.
          const downCommand = this.deleteAllData ? 'down --remove-orphans -v --rmi local' : 'down --remove-orphans --rmi local';
          await dockerService.composeApp(appUrn, downCommand);
          logger.info(`Successfully cleaned up all Docker resources for ${appUrn}`);
        }
      } catch (err) {
        logger.warn('Error taking down app', appUrn, err);
      }

      if (!isPortExpose) {
        // apps.yml keeps a route to the starting page for each app router while its containers are
        // gone (CI-Hub#1944), so rebuild it now, as Stop does; until then the removed app's address
        // would still answer with that page instead of a 404. Straight after compose down, which has
        // already removed the containers, and before the cleanup below, which can throw. ModuleRef.get
        // throws for a provider it cannot resolve, and the containers are gone by now, so that must
        // not fail the uninstall.
        try {
          await this.moduleRef.get(TraefikConfigService, { strict: false })?.regenerateTraefikConfig(0);
        } catch (err) {
          logger.warn(`Failed to rebuild the Traefik routes after removing ${appUrn}: ${err}`);
        }

        // The images this app's installs, updates and starts pulled for it, as recorded when each brought them in, and
        // any another app handed over. Only these are removed, with Delete all data on or off, since an image is not the
        // app's data. An image that was on the computer before any app stays. So does one a container still uses and one
        // another installed app names, which goes on that app's record. All of this runs after compose down, which can
        // take minutes: another uninstall or an install in that time changes the answer and a stale one removes too much.
        const pulledImages = await appFilesManager.readPulledImages(appUrn);
        const { removable, keptFor } = await sortImagesByOtherApps(this.moduleRef, appUrn, pulledImages.imageIds);

        // Explicit post-down cleanup is a safety net for partial teardown states.
        await dockerService.removeAppImages(appUrn, removable, pulledImages.imageTags);
        await dockerService.removeAppNetworks(appUrn);
        await handOverKeptImages(this.moduleRef, appUrn, keptFor, pulledImages.imageTags);
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

      // Deregister agent webhook if registered (R-HOOK-3)
      try {
        const agentNotifyService = this.moduleRef.get(AgentNotifyService, { strict: false });
        if (agentNotifyService) {
          agentNotifyService.unregisterWebhook(appUrn);
        }
      } catch {
        // AgentNotifyService may not be available
      }

      // SEC-MCP-8: revoke the app's managed key (all scopes) so its Hub access dies with the app.
      try {
        const apiKeyService = this.moduleRef.get(ApiKeyService, { strict: false });
        await apiKeyService?.revokeManagedByApp(appUrn);
      } catch (error) {
        logger.warn(`Failed to revoke managed key for ${appUrn}: ${error}`);
      }

      const folderRemoved = await appFilesManager.deleteAppFolder(appUrn);

      // A recursive delete can fail on a container-created root-owned path the Hub
      // process can't remove (e.g. MinIO's `.minio.sys`). Try to self-heal via a
      // privileged (root) cleanup; only if that ALSO fails do we surface a remnant.
      let dataRemoved = true;
      let dataRemnantHostPath: string | undefined;
      if (this.deleteAllData) {
        const outcome = await removeAppDataWithPrivilegedFallback(appFilesManager, dockerService, logger, appUrn);
        dataRemoved = outcome.removed;
        dataRemnantHostPath = outcome.hostPath;
      }

      // The app IS uninstalled — containers, images and networks are gone and the DB
      // record will be dropped — but if a wipe is still only partial (even root
      // couldn't remove it), report success WITHOUT claiming a clean removal and carry
      // the host path so the user can be shown a manual cleanup command (#907).
      if (!folderRemoved || !dataRemoved) {
        const leftover = describeLeftovers(folderRemoved, dataRemoved);

        logger.warn(
          `App ${appUrn} uninstalled, but its ${leftover} could not be fully removed; a disk remnant may remain${dataRemnantHostPath ? ` at ${dataRemnantHostPath}` : ''} (see the filesystem error above — often a container-created root-owned path).`,
        );

        return {
          success: true,
          message: `App ${appUrn} uninstalled, but its ${leftover} could not be fully removed and may leave a remnant on disk.`,
          warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
          ...(dataRemnantHostPath ? { warningDetail: dataRemnantHostPath } : {}),
        };
      }

      return { success: true, message: `App ${appUrn} uninstalled successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'uninstall');
    }
  }
}
