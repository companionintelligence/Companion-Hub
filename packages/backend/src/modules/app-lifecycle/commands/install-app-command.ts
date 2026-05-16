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
import type { AppUrn } from '@ci-hub/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { AppLifecycleCommand, ROCM_KFD_MISSING_MESSAGE } from './command';
import { parseComposeJson } from '@ci-hub/common/schemas';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'yaml';

/**
 * Load the Openclaw fallback entrypoint script from file.
 * This script is used as a last resort if the original ci-entrypoint.sh
 * is missing from the app payload.
 */
async function getOpenclawFallbackEntrypoint(): Promise<string> {
  // At runtime, __dirname is the bundle root (/app). The asset is placed at
  // modules/app-lifecycle/data/ by build.ts, matching dist/ → /app layout.
  const scriptPath = path.join(__dirname, 'modules/app-lifecycle/data/openclaw-ci-entrypoint.sh');
  try {
    return await fs.promises.readFile(scriptPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to load OpenClaw fallback entrypoint from ${scriptPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export class InstallAppCommand extends AppLifecycleCommand {
  private isKfdHostDevice(device: string): boolean {
    const hostDevice = device.split(':')[0]?.trim();
    return hostDevice === '/dev/kfd';
  }

  /**
   * Returns true if any service in the raw user docker-compose.yml override
   * declares /dev/kfd as a device. Failures to parse are silently ignored so
   * a malformed override never blocks an otherwise-valid install.
   */
  private userComposeRequiresKfd(composeYaml: string): boolean {
    try {
      const parsed = yaml.parse(composeYaml) as { services?: Record<string, { devices?: unknown[] } | null> } | null;
      if (!parsed?.services) return false;
      return Object.values(parsed.services).some((svc) => svc?.devices?.some((device) => typeof device === 'string' && this.isKfdHostDevice(device)));
    } catch {
      return false;
    }
  }

  private async assertRequiredHostDevices(appUrn: AppUrn): Promise<void> {
    const config = this.moduleRef.get(ConfigurationService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });

    // Check the base installed compose (docker-compose.json) with architecture overrides applied.
    let requiresKfd = false;
    const composeJson = await appFilesManager.getDockerComposeJson(appUrn);
    if (composeJson.content) {
      const { services, overrides } = parseComposeJson(composeJson.content);
      const architecture = config.get('architecture');
      const mergedServices = mergeArchitectureOverrides(services, overrides, architecture);
      requiresKfd = mergedServices.some((service) =>
        service.devices?.some((device) => {
          if (typeof device !== 'string') {
            return false;
          }
          return this.isKfdHostDevice(device);
        }),
      );
    }

    // Also check the user compose override (user-config/{store}/{app}/docker-compose.yml).
    // composeApp layers this file on top of the generated docker-compose.yml via an additional
    // -f flag. Docker Compose appends list fields across -f files, so an override that adds
    // /dev/kfd will be present in the effective compose even when the base does not require it.
    if (!requiresKfd) {
      const userCompose = await appFilesManager.getUserComposeFile(appUrn);
      if (userCompose.content) {
        requiresKfd = this.userComposeRequiresKfd(userCompose.content);
      }
    }

    if (!requiresKfd) {
      return;
    }

    try {
      await fs.promises.access('/dev/kfd', fs.constants.F_OK);
    } catch {
      throw new Error(ROCM_KFD_MISSING_MESSAGE);
    }
  }

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
      logger.error(`Error parsing docker-compose.yml for app ${appUrn} from marketplace repository. Are you running the latest version of CI Hub?`);
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

      // Host-device preflight — run before any port/env mutation so a failed
      // check is side-effect free (no stale port allocations or env rewrites).
      if (!form.skipRun) {
        await this.assertRequiredHostDevices(appUrn);
      }

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

      // OpenClaw requires a custom bootstrap entrypoint at /data/ci-entrypoint.sh.
      // Ensure the file exists even if copyDataDir was skipped or app payload was incomplete.
      if (appName === 'openclaw') {
        const { appInstalledDir } = appFilesManager.getAppPaths(appUrn);
        const targetDir = path.join(containerAppDataPath, 'data');
        const targetPath = path.join(targetDir, 'ci-entrypoint.sh');
        const sourcePath = path.join(appInstalledDir, 'data', 'ci-entrypoint.sh');

        await fs.promises.mkdir(targetDir, { recursive: true });

        let restoredFromSource = false;
        try {
          await fs.promises.access(sourcePath);
          await fs.promises.copyFile(sourcePath, targetPath);
          restoredFromSource = true;
          logger.info(`[OpenClaw] Restored ci-entrypoint.sh from ${sourcePath}`);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            // Unexpected error (e.g. permission denied, I/O error) — log it but still fall back.
            logger.warn(
              `[OpenClaw] Unexpected error restoring ci-entrypoint.sh from ${sourcePath}: ${
                err instanceof Error ? err.message : String(err)
              }. Falling back to bundled script.`,
            );
          }
          // ENOENT is expected when the app payload is incomplete — proceed to fallback.
        }

        if (restoredFromSource) {
          // Ensure the restored file is executable regardless of source permissions.
          await fs.promises.chmod(targetPath, 0o755);
        } else {
          const fallbackContent = await getOpenclawFallbackEntrypoint();
          // mode: 0o755 sets executable permissions at write time.
          await fs.promises.writeFile(targetPath, fallbackContent, { mode: 0o755 });
          logger.warn('[OpenClaw] ci-entrypoint.sh missing from app payload. Wrote fallback script to preserve startup and Hub inference bootstrap.');
        }
      }

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

      emitProgress(55);
      try {
        await dockerService.composeApp(appUrn, 'down --rmi local --remove-orphans');
      } catch (_) {
        logger.warn(`No prior containers to remove for app ${appUrn}`);
      }

      emitProgress(60);
      await dockerService.composeApp(appUrn, `up --detach --force-recreate --remove-orphans ${forcePull ? '--pull always' : ''}`);
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

      // Register agent webhook if this is an MCP client app (R-HOOK-1)
      if (appInfo.hub_integration?.mcp_client) {
        try {
          const agentNotifyService = this.moduleRef.get(AgentNotifyService, { strict: false });
          if (agentNotifyService) {
            const wakeEndpoint = appInfo.hub_integration.wake_endpoint || '/hooks/hub-wake';
            const wakePort = appInfo.hub_integration.wake_port || appInfo.port || 3000;

            // Resolve the Docker DNS name for the agent container.
            // On the shared ci-os-hub_network, containers are reachable by their
            // Docker Compose service name (from docker-compose.json), NOT by
            // {appName}-{storeId}. Read the main service name from the compose config.
            let serviceName = appName;
            try {
              const composeJson = await appFilesManager.getDockerComposeJson(appUrn);
              if (composeJson.content) {
                const parsed = parseComposeJson(composeJson.content);
                const mainService = parsed.services.find((s) => s.isMain) || parsed.services[0];
                if (mainService?.name) {
                  serviceName = mainService.name;
                }
              }
            } catch (_parseErr) {
              logger.debug(`Could not parse compose for service name, using appName: ${appName}`);
            }

            const webhookUrl = `http://${serviceName}:${wakePort}${wakeEndpoint}`;

            // Read the generated wake secret from the app env
            const agentEnvData = await appFilesManager.getAppEnv(appUrn);
            const agentEnvMap = envUtils.envStringToMap(agentEnvData.content);
            const wakeSecret = agentEnvMap.get('HUB_WAKE_SECRET');

            agentNotifyService.registerWebhook(appUrn, webhookUrl, wakeSecret);
            logger.info(`Registered agent webhook for ${appUrn}: ${webhookUrl}`);
          }
        } catch (hookErr) {
          logger.warn(`Failed to register agent webhook for ${appUrn}: ${hookErr}`);
        }
      }

      emitProgress(99);
      return { success: true, message: `App ${appUrn} installed successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'install');
    }
  }
}
