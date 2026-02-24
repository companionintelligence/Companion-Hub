import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { SSEService } from '@/core/sse/sse.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
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

      // Allocate ports via the port manager
      emitProgress(27);
      try {
        const portManager = this.moduleRef.get(PortManagerService, { strict: false });
        const appInfo = await appFilesManager.getInstalledAppInfo(appUrn);
        if (portManager && appInfo) {
          // Release any existing allocations (in case of reinstall)
          await portManager.releaseAll(appUrn);

          const portRequests: Array<{ containerPort: number; protocol?: 'tcp' | 'udp'; label: string; preferredHostPort?: number }> = [];

          // Main port from config.json
          if (appInfo.port) {
            portRequests.push({
              containerPort: appInfo.port,
              label: 'main',
              preferredHostPort: form.port ?? appInfo.port,
            });
          }

          // Additional ports from docker-compose.json services
          const composeJson = await appFilesManager.getDockerComposeJson(appUrn);
          if (composeJson.content) {
            try {
              const { services } = parseComposeJson(composeJson.content);
              for (const service of services) {
                if (service.addPorts) {
                  for (const addPort of service.addPorts) {
                    const containerPort =
                      typeof addPort.containerPort === 'string' ? Number.parseInt(addPort.containerPort, 10) : addPort.containerPort;
                    const hostPort = typeof addPort.hostPort === 'string' ? Number.parseInt(addPort.hostPort, 10) : addPort.hostPort;
                    if (!Number.isNaN(containerPort) && !Number.isNaN(hostPort)) {
                      portRequests.push({
                        containerPort,
                        label: `${service.name}-${containerPort}`,
                        preferredHostPort: hostPort,
                        protocol: addPort.udp ? 'udp' : 'tcp',
                      });
                    }
                  }
                }
              }
            } catch (parseErr) {
              logger.warn(`Failed to parse compose for extra ports: ${parseErr}`);
            }
          }

          if (portRequests.length > 0) {
            const allocations = await portManager.allocatePorts(appUrn, portRequests);
            logger.info(
              `Allocated ${allocations.length} port(s) for ${appUrn}: ${allocations.map((a) => `${a.hostPort}:${a.containerPort}/${a.protocol} [${a.label}]`).join(', ')}`,
            );

            // Update APP_PORT in the env file with the allocated main port
            const mainAlloc = allocations.find((a) => a.label === 'main');
            if (mainAlloc) {
              const appEnvData = await appFilesManager.getAppEnv(appUrn);
              const envMap = envUtils.envStringToMap(appEnvData.content);
              envMap.set('APP_PORT', String(mainAlloc.hostPort));

              // Update APP_INTERNAL_AUTHORITY with allocated port
              const internalIp = envMap.get('APP_HOSTNAME') || _config.getConfig().internalIp;
              envMap.set('APP_INTERNAL_AUTHORITY', `${internalIp}:${mainAlloc.hostPort}`);

              // Also update form.port so ensureAppDir uses the right port
              form.port = mainAlloc.hostPort;

              await appFilesManager.writeAppEnv(appUrn, envUtils.envMapToString(envMap));
            }
          }
        }
      } catch (portErr) {
        logger.warn(`Port allocation failed, falling back to config defaults: ${portErr}`);
      }

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
      const { directories } = _config.getConfig();
      const containerAppDataPath = path.join(directories.appDataDir, appStoreId, appName);
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

      // Pre-create volume mount directories and set permissions BEFORE compose up
      // so containers don't crash on first start due to root-owned mount dirs
      // (affects code-server, file-browser, forgejo, graylog, passbolt, vaultwarden)
      try {
        // Parse compose to find all host volume paths and pre-create them
        const preComposeJson = await appFilesManager.getDockerComposeJson(appUrn);
        if (preComposeJson.content) {
          try {
            const { services: preServices } = parseComposeJson(preComposeJson.content);
            const { appStoreId: preStoreId, appName: preName } = extractAppUrn(appUrn);
            const preContainerAppDataPath = path.join(_config.getConfig().directories.appDataDir, preStoreId, preName);
            for (const svc of preServices) {
              if (svc.volumes) {
                for (const vol of svc.volumes) {
                  if (typeof vol === 'object' && 'hostPath' in vol) {
                    // Replace ${APP_DATA_DIR} with container path
                    const hostPath = (vol.hostPath as string).replace(/\$\{APP_DATA_DIR\}/g, preContainerAppDataPath);
                    if (hostPath.startsWith(preContainerAppDataPath)) {
                      await fs.promises.mkdir(hostPath, { recursive: true }).catch(() => {
                        /* ignore mkdir errors */
                      });
                    }
                  }
                }
              }
            }
          } catch (parseErr) {
            logger.debug(`[AppDiag] Could not pre-create volume dirs: ${parseErr}`);
          }
        }
        await appFilesManager.setAppDataDirPermissions(appUrn);
        logger.info(`[AppDiag] Pre-created volume dirs and set permissions for ${appUrn}`);
      } catch (permErr) {
        logger.warn(`[AppDiag] Pre-set permissions failed for ${appUrn}: ${permErr}`);
      }

      emitProgress(50);
      try {
        await dockerService.composeApp(appUrn, 'down --rmi local --remove-orphans');
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
      await dockerService.composeApp(appUrn, `up --detach --force-recreate --remove-orphans ${forcePull ? '--pull always' : '--pull never'}`);
      emitProgress(80);
      await appFilesManager.setAppDataDirPermissions(appUrn);

      // Post-start health check: fire-and-forget — don't block install completion
      emitProgress(85);
      setTimeout(async () => {
        try {
          const diagResults = await dockerService.diagnoseAppContainers(appUrn);
          if (diagResults.unhealthy.length > 0) {
            const errorSummary = diagResults.unhealthy.map((c) => `${c.name} (${c.state}): ${c.logs}`).join('\n');
            logger.warn(`[AppDiag] App ${appUrn} has unhealthy containers:\n${errorSummary}`);
          } else {
            logger.info(`[AppDiag] All containers healthy for ${appUrn}`);
          }
        } catch (diagErr) {
          logger.warn(`[AppDiag] Post-start diagnostics failed for ${appUrn}: ${diagErr}`);
        }
      }, 30000);

      // Create Cloudflare Tunnel route if exposedLocal is enabled (app is published to internet)
      // This part now uses CloudflareClientService to SYNC state with CI-Cloud
      // CI-Cloud will handle the actual DNS and Tunnel updates via the trigger in AppLifecycleService
      logger.info(`[Cloudflare] Syncing state for ${appUrn}, exposureMode: ${form.exposureMode || (form.exposedLocal ? 'cloudflare' : 'local')}`);
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

      // Regenerate Traefik file-based config after app is installed and started
      const effectiveExposure = form.exposureMode || (form.exposedLocal ? 'cloudflare' : 'local');
      if (effectiveExposure !== 'local' && !form.skipRun) {
        const traefikConfigService = this.moduleRef.get(TraefikConfigService, { strict: false });
        if (traefikConfigService) {
          logger.debug(`Regenerating Traefik config for newly installed exposed app ${appUrn}`);
          // Wait longer for container to fully start and network to be attached
          await traefikConfigService.regenerateTraefikConfig(5000); // Wait 5s for container to fully start
        }
      }

      emitProgress(99);
      return { success: true, message: `App ${appUrn} installed successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'install');
    }
  }
}
