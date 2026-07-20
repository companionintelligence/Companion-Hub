import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { DockerService } from '@/modules/docker/docker.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { McpApiKeyService } from '@/modules/mcp/mcp-api-key.service';
import type { AppUrn } from '@ci-hub/common/types';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { AppLifecycleCommand } from './command';

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

      // Capture image IDs before compose down so we can remove pulled images by
      // immutable ID even when tags/compose refs are no longer resolvable.
      const snapshotImageIds = isPortExpose ? [] : await dockerService.snapshotAppImageIds(appUrn);

      try {
        if (!isPortExpose) {
          const downCommand = this.deleteAllData ? 'down --remove-orphans -v --rmi all' : 'down --remove-orphans --rmi all';
          await dockerService.composeApp(appUrn, downCommand);
          logger.info(`Successfully cleaned up all Docker resources for ${appUrn}`);
        }
      } catch (err) {
        logger.warn('Error taking down app', appUrn, err);
      }

      if (!isPortExpose) {
        // Explicit post-down cleanup is a safety net for partial teardown states.
        await dockerService.removeAppImages(appUrn, snapshotImageIds);
        await dockerService.removeAppNetworks(appUrn);
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

      // SEC-MCP-8: revoke the app's managed MCP key so its Hub access dies with the app.
      try {
        const mcpApiKeyService = this.moduleRef.get(McpApiKeyService, { strict: false });
        await mcpApiKeyService?.revokeManagedByApp(appUrn);
      } catch (error) {
        logger.warn(`Failed to revoke managed MCP key for ${appUrn}: ${error}`);
      }

      const folderRemoved = await appFilesManager.deleteAppFolder(appUrn);

      // A recursive delete can fail on a container-created root-owned path the Hub
      // process can't remove (e.g. MinIO's `.minio.sys`). Try to self-heal via a
      // privileged (root) cleanup; only if that ALSO fails do we surface a remnant.
      let dataRemoved = true;
      let dataRemnantHostPath: string | undefined;
      if (this.deleteAllData) {
        const outcome = await this.removeAppDataWithPrivilegedFallback(appFilesManager, dockerService, logger, appUrn);
        dataRemoved = outcome.removed;
        dataRemnantHostPath = outcome.hostPath;
      }

      // The app IS uninstalled — containers, images and networks are gone and the DB
      // record will be dropped — but if a wipe is still only partial (even root
      // couldn't remove it), report success WITHOUT claiming a clean removal and carry
      // the host path so the user can be shown a manual cleanup command (#907).
      if (!folderRemoved || !dataRemoved) {
        const leftovers: string[] = [];
        if (!folderRemoved) leftovers.push('app folder');
        if (!dataRemoved) leftovers.push('app data');
        const leftover = leftovers.join(' and ');

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

  /**
   * Remove the app's data dir, escalating to a privileged (root) cleanup when the
   * non-root delete hits a permission error (a container-created root-owned path such
   * as MinIO's `.minio.sys`). Returns whether it's gone and — when it isn't — the HOST
   * path to surface for a manual `rm`.
   */
  private async removeAppDataWithPrivilegedFallback(
    appFilesManager: AppFilesManager,
    dockerService: DockerService,
    logger: LoggerService,
    appUrn: AppUrn,
  ): Promise<{ removed: boolean; hostPath?: string }> {
    const first = await appFilesManager.deleteAppDataDirDetailed(appUrn);
    if (first.removed) {
      return { removed: true };
    }

    // The host path is ONLY for user-facing guidance (the manual `rm` command), so
    // resolving it must never turn an otherwise-successful uninstall into a failure.
    // getAppDataHostDir can throw on a misconfigured non-absolute ROOT_FOLDER_HOST;
    // treat that as "path unavailable" (a generic remnant warning) rather than aborting.
    let hostPath: string | undefined;
    try {
      hostPath = appFilesManager.getAppDataHostDir(appUrn);
    } catch (err) {
      logger.warn(
        `App ${appUrn}: could not resolve host app-data path for manual-cleanup guidance: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Only a permission error is worth escalating to root — anything else won't be
    // fixed by root either, so surface the manual path straight away.
    if (!first.permissionDenied) {
      return { removed: false, hostPath };
    }

    logger.warn(`App ${appUrn} app-data not removable as non-root; attempting a privileged cleanup of ${hostPath ?? 'its data directory'}`);
    const emptied = await dockerService.removeAppDataDirAsRoot(appUrn);
    // The helper only empties the dir (never the mountpoint), so the Hub still removes
    // the now-empty directory itself — re-verify from the Hub's own view.
    if (emptied && (await appFilesManager.deleteAppDataDir(appUrn))) {
      logger.info(`App ${appUrn} app-data removed via privileged cleanup`);
      return { removed: true };
    }

    return { removed: false, hostPath };
  }
}
