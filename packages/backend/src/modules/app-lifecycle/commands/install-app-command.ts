import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { SSEService } from '@/core/sse/sse.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { resolveBrowserHost } from '@/common/helpers/browser-host';
import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { AppLifecycleCommand, type CommandExecutionContext } from './command';
import { createKvmMissingError, createRocmKfdMissingError, AppLifecycleError, type AppCommandResult } from './app-lifecycle-errors';
import { isAbortError, throwIfAborted } from '@/common/abort';
import { parseComposeJson } from '@ci-hub/common/schemas';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { McpProbeService } from '@/modules/mcp/mcp-probe.service';
import { isRocmKfdPassthroughAvailable } from '@/modules/inference/host-rocm-availability';
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'yaml';

async function isKvmDeviceAvailable(): Promise<boolean> {
  try {
    await fs.promises.access('/dev/kvm', fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const DOWNLOAD_PROGRESS_START = 60;
const DOWNLOAD_PROGRESS_END = 99;
const DOWNLOAD_PROGRESS_MAX_DURING_PULL = 98;
const DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS = 250;

export function extractComposeImages(composeContent: unknown): string[] {
  const { services } = parseComposeJson(composeContent);
  return [...new Set(services.map((service) => service.image?.trim()).filter((image): image is string => Boolean(image)))];
}

export function mapPullProgressToInstallProgress(completedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) {
    return DOWNLOAD_PROGRESS_START;
  }

  const normalized = Math.max(0, Math.min(1, completedBytes / totalBytes));
  const mapped = DOWNLOAD_PROGRESS_START + Math.floor(normalized * (DOWNLOAD_PROGRESS_END - DOWNLOAD_PROGRESS_START));
  return Math.max(DOWNLOAD_PROGRESS_START, Math.min(DOWNLOAD_PROGRESS_MAX_DURING_PULL, mapped));
}

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
  private hostDevicePath(device: string): string | null {
    const hostDevice = device.split(':')[0]?.trim();
    return hostDevice || null;
  }

  private isKfdHostDevice(device: string): boolean {
    return this.hostDevicePath(device) === '/dev/kfd';
  }

  private isKvmHostDevice(device: string): boolean {
    return this.hostDevicePath(device) === '/dev/kvm';
  }

  /**
   * Returns which special host devices a raw user docker-compose.yml override
   * declares. Failures to parse are silently ignored so a malformed override
   * never blocks an otherwise-valid install.
   */
  private userComposeRequiredDevices(composeYaml: string): { requiresKfd: boolean; requiresKvm: boolean } {
    try {
      const parsed = yaml.parse(composeYaml) as { services?: Record<string, { devices?: unknown[] } | null> } | null;
      if (!parsed?.services) return { requiresKfd: false, requiresKvm: false };
      let requiresKfd = false;
      let requiresKvm = false;
      for (const svc of Object.values(parsed.services)) {
        for (const device of svc?.devices ?? []) {
          if (typeof device !== 'string') continue;
          if (this.isKfdHostDevice(device)) requiresKfd = true;
          if (this.isKvmHostDevice(device)) requiresKvm = true;
        }
      }
      return { requiresKfd, requiresKvm };
    } catch {
      return { requiresKfd: false, requiresKvm: false };
    }
  }

  private async assertRequiredHostDevices(appUrn: AppUrn): Promise<void> {
    const config = this.moduleRef.get(ConfigurationService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });

    // Check the base installed compose (docker-compose.json) with architecture overrides applied.
    let requiresKfd = false;
    let requiresKvm = false;
    const composeJson = await appFilesManager.getDockerComposeJson(appUrn);
    if (composeJson.content) {
      const { services, overrides } = parseComposeJson(composeJson.content);
      const architecture = config.get('architecture');
      const mergedServices = mergeArchitectureOverrides(services, overrides, architecture);
      for (const service of mergedServices) {
        for (const device of service.devices ?? []) {
          if (typeof device !== 'string') continue;
          if (this.isKfdHostDevice(device)) requiresKfd = true;
          if (this.isKvmHostDevice(device)) requiresKvm = true;
        }
      }
    }

    // Also check the user compose override (user-config/{store}/{app}/docker-compose.yml).
    // composeApp layers this file on top of the generated docker-compose.yml via an additional
    // -f flag. Docker Compose appends list fields across -f files, so an override that adds
    // /dev/kfd or /dev/kvm will be present in the effective compose even when the base does not.
    if (!requiresKfd || !requiresKvm) {
      const userCompose = await appFilesManager.getUserComposeFile(appUrn);
      if (userCompose.content) {
        const fromUser = this.userComposeRequiredDevices(userCompose.content);
        requiresKfd = requiresKfd || fromUser.requiresKfd;
        requiresKvm = requiresKvm || fromUser.requiresKvm;
      }
    }

    if (requiresKfd && !(await isRocmKfdPassthroughAvailable())) {
      throw createRocmKfdMissingError();
    }

    if (requiresKvm && !(await isKvmDeviceAvailable())) {
      throw createKvmMissingError();
    }
  }

  public async execute(appUrn: AppUrn, form: AppEventFormInput, ctx?: CommandExecutionContext): Promise<AppCommandResult> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const _config = this.moduleRef.get(ConfigurationService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const marketplaceService = this.moduleRef.get(MarketplaceService, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const envUtils = this.moduleRef.get(EnvUtils, { strict: false });
    const sseService = this.moduleRef.get(SSEService, { strict: false });
    const appsRepository = this.moduleRef.get(AppsRepository, { strict: false });

    const emitProgress = async (progress: number) => {
      if (sseService) {
        sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'installing', progress }, appUrn);
      }
      if (appsRepository) {
        const app = await appsRepository.getAppByUrn(appUrn);
        if (app?.status === 'installing') {
          await appsRepository.updateAppById(app.id, { updatedAt: new Date().toISOString() });
        }
      }
    };

    let composeToInstallContent: unknown;
    try {
      const composeToInstall = await marketplaceService.getDockerComposeJson(appUrn);
      if (!composeToInstall.content) {
        throw new Error(`Invalid marketplace compose payload for ${appUrn}`);
      }
      composeToInstallContent = composeToInstall.content;
      parseComposeJson(composeToInstallContent);
    } catch (err) {
      logger.error(`Error parsing docker-compose.yml for app ${appUrn} from marketplace repository. Are you running the latest version of CI Hub?`);
      return this.handleAppError(err, appUrn, 'update_error');
    }

    try {
      ctx?.setPhase('preparing');
      const appImages = extractComposeImages(composeToInstallContent);
      await emitProgress(5);
      if (process.getuid && process.getgid) {
        logger.info(`Installing app ${appUrn} as User ID: ${process.getuid()}, Group ID: ${process.getgid()}`);
      } else {
        logger.info(`Installing app ${appUrn}. No User ID or Group ID found.`);
      }

      await emitProgress(15);
      await marketplaceService.copyAppFromRepoToInstalled(appUrn);

      // Host-device preflight — run before any port/env mutation so a failed
      // check is side-effect free (no stale port allocations or env rewrites).
      if (!form.skipRun) {
        await this.assertRequiredHostDevices(appUrn);
      }

      // Create app.env file
      await emitProgress(25);
      logger.info(`Creating app.env file for app ${appUrn}`);
      await appHelpers.generateEnvFile(appUrn, form);

      // Allocate ports via the port manager
      await emitProgress(27);
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

              // Keep URL/origin vars aligned with generateEnvFile (browser host, not bind address).
              const bindHost = envMap.get('APP_HOSTNAME') || _config.getConfig().internalIp;
              const browserHost = resolveBrowserHost(bindHost);
              const internalAuthority = `${browserHost}:${mainAlloc.hostPort}`;
              envMap.set('APP_INTERNAL_AUTHORITY', internalAuthority);
              if (envMap.get('APP_EXPOSED') !== 'true') {
                envMap.set('APP_HOST', browserHost);
                envMap.set('APP_DOMAIN', internalAuthority);
                envMap.set('APP_URL', `http://${internalAuthority}`);
              }

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
      await emitProgress(30);
      await this.ensureAppDir(appUrn, form);

      // Copy data dir
      await emitProgress(35);
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

      // OpenClaw requires two bootstrap scripts at /data/:
      //   ci-wrapper.sh    — the docker-compose entrypoint; validates ci-entrypoint.sh then execs it
      //   ci-entrypoint.sh — the actual Hub inference auto-config script
      // Ensure both exist even if copyDataDir was skipped or the app payload was incomplete.
      if (appName === 'openclaw') {
        const { appInstalledDir } = appFilesManager.getAppPaths(appUrn);
        const appRepoDir = path.join(directories.dataDir, 'repos', appStoreId, 'apps', appName);
        const targetDir = path.join(containerAppDataPath, 'data');
        await fs.promises.mkdir(targetDir, { recursive: true });

        // Helper: copy a file from the installed app payload to the data volume,
        // falling back to the provided content string if the source is absent.
        const ensureScript = async (filename: string, fallbackContent: string, fallbackWarning: string) => {
          const targetPath = path.join(targetDir, filename);
          const candidateSources = [path.join(appInstalledDir, 'data', filename), path.join(appRepoDir, 'data', filename)];
          let restoredFromSource = false;
          for (const sourcePath of candidateSources) {
            try {
              await fs.promises.access(sourcePath);
              await fs.promises.copyFile(sourcePath, targetPath);
              restoredFromSource = true;
              logger.info(`[OpenClaw] Restored ${filename} from ${sourcePath}`);
              break;
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.warn(
                  `[OpenClaw] Unexpected error restoring ${filename} from ${sourcePath}: ${
                    err instanceof Error ? err.message : String(err)
                  }. Trying next source.`,
                );
              }
            }
          }
          if (restoredFromSource) {
            await fs.promises.chmod(targetPath, 0o755);
          } else {
            await fs.promises.writeFile(targetPath, fallbackContent, { mode: 0o755 });
            logger.warn(fallbackWarning);
          }
        };

        // ci-wrapper.sh — thin shell wrapper that is the docker-compose entrypoint.
        // It validates ci-entrypoint.sh is present before exec-ing it, giving a clear
        // error message on misconfiguration instead of a cryptic shell failure.
        const wrapperFallback = [
          '#!/bin/sh',
          '# CI Hub OpenClaw startup wrapper — ensures ci-entrypoint.sh exists before execution.',
          'set -e',
          'ENTRYPOINT_PATH="/data/ci-entrypoint.sh"',
          `if [ ! -f "\${ENTRYPOINT_PATH}" ]; then`,
          `  echo "FATAL: \${ENTRYPOINT_PATH} not found. Reinstall the app from CI Hub."`,
          '  exit 1',
          'fi',
          `exec "\${ENTRYPOINT_PATH}"`,
          '',
        ].join('\n');

        await ensureScript('ci-wrapper.sh', wrapperFallback, '[OpenClaw] ci-wrapper.sh missing from app payload. Wrote fallback wrapper script.');

        await ensureScript(
          'ci-entrypoint.sh',
          await getOpenclawFallbackEntrypoint(),
          '[OpenClaw] ci-entrypoint.sh missing from app payload. Wrote fallback script to preserve startup and Hub inference bootstrap.',
        );
      }

      await emitProgress(45);

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
                  // Named volumes carry no host path to pre-create.
                  if (typeof vol === 'object' && typeof vol.hostPath === 'string') {
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
        await emitProgress(99);
        return { success: true, message: `App ${appUrn} installed successfully (skipped run)` };
      }

      // Entering the killable phase: from here a cancel aborts the pull/compose and runs compensation.
      ctx?.setPhase('pulling');
      throwIfAborted(ctx?.signal);

      await emitProgress(55);
      try {
        await dockerService.composeApp(appUrn, 'down --rmi local --remove-orphans', ctx?.signal);
      } catch (downErr) {
        // A cancellation during this preparatory down must propagate, not be swallowed as "no prior containers".
        if (isAbortError(downErr)) {
          throw downErr;
        }
        logger.warn(`No prior containers to remove for app ${appUrn}`);
      }

      await emitProgress(60);
      if (appImages.length > 0) {
        let lastPullProgress = DOWNLOAD_PROGRESS_START;
        let lastPullProgressAt = 0;
        dockerService.pullImages
          ? await dockerService.pullImages(appImages, {
              forcePull,
              signal: ctx?.signal,
              onProgress: ({ completedBytes, totalBytes, completedImages, totalImages }) => {
                const nextProgress =
                  totalBytes > 0
                    ? mapPullProgressToInstallProgress(completedBytes, totalBytes)
                    : totalImages > 0
                      ? mapPullProgressToInstallProgress(completedImages, totalImages)
                      : DOWNLOAD_PROGRESS_START;
                const now = Date.now();
                if (
                  nextProgress > lastPullProgress &&
                  (nextProgress - lastPullProgress >= 2 ||
                    now - lastPullProgressAt >= DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS ||
                    nextProgress >= DOWNLOAD_PROGRESS_MAX_DURING_PULL)
                ) {
                  lastPullProgress = nextProgress;
                  lastPullProgressAt = now;
                  void emitProgress(nextProgress);
                }
              },
            })
          : logger.warn(`Docker pull progress tracking is unavailable for ${appUrn}; falling back to compose up progress`);
      }

      // Entering compose-up. This remains cancellable; the abort kills `compose up` and compensation
      // tears down whatever was partially created.
      ctx?.setPhase('composing');
      throwIfAborted(ctx?.signal);

      await emitProgress(99);
      await this.composeAppWithNetworkRecovery(appUrn, form, 'up --detach --force-recreate --remove-orphans', 3, ctx?.signal);
      await appFilesManager.setAppDataDirPermissions(appUrn);

      // Honor a cancel that landed while `compose up` was running but still completed: install is a
      // "safe" tier op, so we abort + compensate (remove the just-created app) rather than finish.
      throwIfAborted(ctx?.signal);

      // Containers are up and the cancel window is closed — past the point of no return. Cancel is
      // refused beyond this phase (see AppLifecycleService.cancelOperation).
      ctx?.setPhase('finalizing');

      const containerVerification = await dockerService.waitForManagedAppContainersReady(appUrn);
      if (!containerVerification.ok) {
        logger.error(
          `[AppDiag] Post-install container verification failed for ${appUrn}: ${containerVerification.message}${
            containerVerification.errorDetail ? `\n${containerVerification.errorDetail}` : ''
          }`,
        );
        throw new AppLifecycleError(containerVerification.message, {
          detail: containerVerification.errorDetail ?? containerVerification.message,
        });
      }

      // Supplemental health check for slow-fail crashes after the initial verification.
      setTimeout(async () => {
        try {
          const dockerReadFacade = this.moduleRef.get(DockerReadFacade, { strict: false });
          if (!dockerReadFacade) {
            return;
          }
          const diagResults = await dockerReadFacade.diagnoseAppContainers(appUrn);
          if (diagResults.unhealthy.length > 0) {
            const errorSummary = diagResults.unhealthy.map((c) => `${c.name} (${c.state}): ${c.logs}`).join('\n');
            logger.warn(`[AppDiag] App ${appUrn} has unhealthy containers:\n${errorSummary}`);

            const errorReportingService = this.moduleRef.get(ErrorReportingService, { strict: false });
            errorReportingService?.reportAppFailure({
              appUrn,
              phase: 'post_start',
              message: errorSummary,
              containers: diagResults.unhealthy,
            });
          } else {
            logger.info(`[AppDiag] All containers healthy for ${appUrn}`);
          }
        } catch (diagErr) {
          logger.warn(`[AppDiag] Post-start diagnostics failed for ${appUrn}: ${diagErr}`);
        }
      }, 30000);

      // Cloudflare public DNS/tunnel sync runs in AppLifecycleService.syncExposure()
      // once the install completes and the app is marked running — not here.

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

      // Register the agent wake webhook for MCP-client apps (R-HOOK-1).
      //
      // The target is resolved by AgentNotifyService from what is on disk, so install and
      // the startup rehydration cannot drift apart — they call the same code.
      try {
        const agentNotifyService = this.moduleRef.get(AgentNotifyService, { strict: false });
        const target = await agentNotifyService?.resolveWebhookTarget(appUrn);
        if (target) {
          agentNotifyService.registerWebhook(appUrn, target.url, target.token);
        }
      } catch (hookErr) {
        logger.warn(`Failed to register agent webhook for ${appUrn}: ${hookErr}`);
      }

      await emitProgress(99);
      await this.markInstallSucceeded(appUrn, sseService, appsRepository, logger);

      try {
        const mcpProbe = this.moduleRef.get(McpProbeService, { strict: false });
        mcpProbe?.scheduleProbe(appUrn);
      } catch (probeErr) {
        logger.debug(`MCP post-install probe not scheduled for ${appUrn}: ${probeErr}`);
      }

      return { success: true, message: `App ${appUrn} installed successfully` };
    } catch (err) {
      // A user-requested cancel: tear down whatever was partially created and report a cancellation
      // (not a failure). The service finalizes the cancel (deletes the record + emits install_cancelled).
      if (isAbortError(err)) {
        const message = await this.compensateInstallCancel(appUrn);
        return { success: false, cancelled: true, message };
      }
      return this.handleAppError(err, appUrn, 'install');
    }
  }

  /**
   * Best-effort cleanup after an install is cancelled mid-flight: tears down containers, the app's own
   * volumes, project networks, port allocations, the agent webhook, and the app/data directories so no
   * orphaned resources are left behind. Pulled images are intentionally kept (faster re-install, and so
   * we never force-remove an image another installed app might share). Every step is individually
   * guarded and idempotent; the compose-down runs WITHOUT the (now-aborted) signal so cleanup completes.
   * Does NOT delete the DB record — the service owns that (see AppLifecycleService.handleCancelledResult).
   *
   * @returns A human-readable summary message for the cancellation result.
   */
  private async compensateInstallCancel(appUrn: AppUrn): Promise<string> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });

    logger.info(`[install-cancel] compensating cancelled install for ${appUrn}`);

    // Release allocated ports.
    try {
      const portManager = this.moduleRef.get(PortManagerService, { strict: false });
      if (portManager) {
        const released = await portManager.releaseAll(appUrn);
        if (released > 0) {
          logger.info(`[install-cancel] released ${released} port allocation(s) for ${appUrn}`);
        }
      }
    } catch (err) {
      logger.warn(`[install-cancel] failed to release ports for ${appUrn}: ${err}`);
    }

    // Tear down whatever was partially created. `--rmi local` only removes locally-built images and
    // `-v` removes the app's own anonymous volumes — pulled images are intentionally kept (faster
    // re-install, and we never force-remove an image another installed app might share). This mirrors
    // the ticket's cleanup intent for install cancel.
    try {
      await dockerService.composeApp(appUrn, 'down --remove-orphans -v --rmi local');
    } catch (err) {
      logger.warn(`[install-cancel] compose down failed for ${appUrn} (continuing): ${err}`);
    }

    // Safety net for partial-teardown states: remove any leftover project networks.
    await dockerService.removeAppNetworks(appUrn).catch((err) => logger.warn(`[install-cancel] removeAppNetworks failed for ${appUrn}: ${err}`));

    // Deregister any agent webhook that may have been registered before the abort.
    try {
      const agentNotifyService = this.moduleRef.get(AgentNotifyService, { strict: false });
      agentNotifyService?.unregisterWebhook(appUrn);
    } catch {
      // AgentNotifyService may be unavailable; ignore.
    }

    await appFilesManager.deleteAppFolder(appUrn).catch((err) => logger.warn(`[install-cancel] deleteAppFolder failed for ${appUrn}: ${err}`));
    await appFilesManager.deleteAppDataDir(appUrn).catch((err) => logger.warn(`[install-cancel] deleteAppDataDir failed for ${appUrn}: ${err}`));

    logger.info(`[install-cancel] compensation complete for ${appUrn}`);
    return `Install of ${appUrn} was cancelled and cleaned up`;
  }

  private async markInstallSucceeded(
    appUrn: AppUrn,
    sseService: SSEService | undefined,
    appsRepository: AppsRepository | undefined,
    logger: LoggerService,
  ): Promise<void> {
    if (!appsRepository) return;

    const app = await appsRepository.getAppByUrn(appUrn);
    if (!app) {
      logger.warn(`Install completed for ${appUrn} but no app record exists; skipping status update`);
      return;
    }

    if (app.status !== 'installing') {
      return;
    }

    await appsRepository.updateAppById(app.id, { status: 'running' });
    sseService?.emit('app', { event: 'install_success', appUrn, appStatus: 'running' });
  }
}
