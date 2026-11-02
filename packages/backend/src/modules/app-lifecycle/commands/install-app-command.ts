import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { SSEService } from '@/core/sse/sse.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers, deriveAppBaseWsOrigin, parseAppBaseUrl } from '@/modules/apps/app.helpers';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { ImageSizeService } from '@/modules/marketplace/image-size.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { extractConflictingHostBinding } from '@/modules/network/docker-port-errors';
import { PortManagerService, type PortAllocation } from '@/modules/network/port-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { resolveBrowserHost } from '@/common/helpers/browser-host';
import { AppLifecycleCommand, type CommandExecutionContext } from './command';
import { AppLifecycleError, type AppCommandResult } from './app-lifecycle-errors';
import { pullAppImagesRecorded } from './pull-app-images';
import { isAbortError, throwIfAborted } from '@/common/abort';
import { parseComposeJson } from '@ci-hub/common/schemas';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { McpProbeService } from '@/modules/mcp/mcp-probe.service';
import { buildComposePortRequests, buildMainPortRequest, type PortRequestInput } from '../planning/port-requests';
import fs from 'node:fs';
import path from 'node:path';

const DOWNLOAD_PROGRESS_START = 60;
const DOWNLOAD_PROGRESS_END = 99;
const DOWNLOAD_PROGRESS_MAX_DURING_PULL = 98;
const DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS = 250;
/**
 * The bar moves in whole percents, so a large download can sit on one for minutes. The size
 * under it still moves, but no more often than this.
 */
const DOWNLOAD_SIZE_EMIT_INTERVAL_MS = 2_000;

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
 * `url` with the port `from` it names replaced by `to`. A URL that names another port or none (a
 * public `https` address), or a value that is not an http(s) URL, comes back unchanged.
 */
export function withMovedPort(url: string, from: number, to: number): string {
  const match = /^(https?:\/\/(?:\[[^\]]*\]|[^/:?#@]+)):(\d{1,5})(?=$|[/?#])/i.exec(url);
  return match && Number(match[2]) === from ? `${match[1]}:${to}${url.slice(match[0].length)}` : url;
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
    // Only for the download's size under the progress bar: an install never fails for want of it.
    const imageSizeService = (() => {
      try {
        return this.moduleRef.get(ImageSizeService, { strict: false });
      } catch {
        return undefined;
      }
    })();

    // The job's last recorded percent. A tick that only moves the download size leaves it alone.
    let jobProgress: number | undefined;
    const emitProgress = async (progress: number, download?: { downloadedBytes: number; totalBytes: number }) => {
      // Sent before the writes below: the pull's ticks are not awaited, and a tick that waited on
      // a write could reach the page after a later one, or after the install's last event.
      if (sseService) {
        // No `appUrn` third argument: that publishes to the `app:<urn>` topic, which
        // nothing subscribes to (`sse.controller.ts` opens `getTopicObservable('app')`
        // with no urn), so every install-progress tick was dropped before it reached
        // the progress bar in `app-sse-cache.ts`.
        sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'installing', progress, ...download });
      }
      if (ctx?.updateProgress && progress !== jobProgress) {
        jobProgress = progress;
        await ctx.updateProgress(progress).catch(() => null);
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
      await this.assertMarketplaceEntitlement(appUrn, 'install');
      await this.assertPlanConfigAndArchitecture(appUrn, form);
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

          const portRequests: PortRequestInput[] = [];

          // Main port from config.json
          const mainPortRequest = buildMainPortRequest(appInfo.port, form.port);
          if (mainPortRequest) {
            portRequests.push(mainPortRequest);
          }

          // Additional ports from docker-compose.json services
          const composeJson = await appFilesManager.getDockerComposeJson(appUrn);
          if (composeJson.content) {
            try {
              portRequests.push(...buildComposePortRequests(composeJson.content));
            } catch (parseErr) {
              logger.warn(`Failed to parse compose for extra ports: ${parseErr}`);
            }
          }

          if (portRequests.length > 0) {
            const allocations = await portManager.allocatePorts(appUrn, portRequests);
            logger.info(
              `Allocated ${allocations.length} port(s) for ${appUrn}: ${allocations.map((a) => `${a.hostPort}:${a.containerPort}/${a.protocol} [${a.label}]`).join(', ')}`,
            );

            const mainAlloc = allocations.find((a) => a.label === 'main');
            if (mainAlloc) {
              await this.applyMainHostPort(appUrn, form, mainAlloc);
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
        await appFilesManager.createVolumeHostDirs(appUrn);
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
        let lastPullBytes = 0;
        let sizeShown = false;
        dockerService.pullImages
          ? await pullAppImagesRecorded({ docker: dockerService, files: appFilesManager, logger }, appUrn, appImages, () =>
              dockerService.pullImages(appImages, {
                forcePull,
                signal: ctx?.signal,
                layerSizes: (image, signal) => imageSizeService?.getImageLayerSizes?.(image, { signal }) ?? Promise.resolve(null),
                onProgress: ({ completedBytes, totalBytes, totalBytesKnown, completedImages, totalImages }) => {
                  // The size under the bar and the bar itself wait for a final total. "3.0 MB / 3.7 MB" for a
                  // 26 MB download was a total still growing (CI-Hub#2177). A first layer of 405 bytes, done at
                  // once, put the bar at 98. Until then the page says only "Downloading" and the bar counts images.
                  const sizeKnown = totalBytes > 0 && totalBytesKnown !== false;
                  const nextProgress = sizeKnown
                    ? mapPullProgressToInstallProgress(completedBytes, totalBytes)
                    : totalImages > 0
                      ? mapPullProgressToInstallProgress(completedImages, totalImages)
                      : DOWNLOAD_PROGRESS_START;
                  const now = Date.now();
                  const percentRose =
                    nextProgress > lastPullProgress &&
                    (nextProgress - lastPullProgress >= 2 ||
                      now - lastPullProgressAt >= DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS ||
                      nextProgress >= DOWNLOAD_PROGRESS_MAX_DURING_PULL);
                  const sizeMoved = completedBytes !== lastPullBytes && now - lastPullProgressAt >= DOWNLOAD_SIZE_EMIT_INTERVAL_MS;
                  const sizeAppeared = sizeKnown && !sizeShown;
                  if (percentRose || sizeMoved || sizeAppeared) {
                    // The bar never goes back.
                    lastPullProgress = Math.max(lastPullProgress, nextProgress);
                    lastPullProgressAt = now;
                    lastPullBytes = completedBytes;
                    sizeShown = sizeKnown;
                    void emitProgress(lastPullProgress, sizeKnown ? { downloadedBytes: completedBytes, totalBytes } : undefined);
                  }
                },
              }),
            )
          : logger.warn(`Docker pull progress tracking is unavailable for ${appUrn}; falling back to compose up progress`);
      }

      // Entering compose-up. This remains cancellable; the abort kills `compose up` and compensation
      // tears down whatever was partially created.
      ctx?.setPhase('composing');
      throwIfAborted(ctx?.signal);

      await emitProgress(99);
      const refusedHostPorts = new Set<number>();
      await this.composeAppWithNetworkRecovery(appUrn, form, 'up --detach --force-recreate --remove-orphans', 3, ctx?.signal, {
        recoverHostPortConflict: (error) => this.moveMainPortOffConflict(appUrn, form, error, refusedHostPorts),
      });
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
   * Re-validates config and architecture — via `AppLifecycleService.buildInstallPlan`, the same
   * preview a caller can request through `POST :urn/install/plan` — before any mutation. Both were
   * already checked once at submission time (`AppLifecycleService.installApp`), but a queued
   * install can sit for a while, and neither is re-checked anywhere else once the job runs.
   * Calling the shared plan builder rather than re-deriving these checks keeps this from drifting
   * from what the preview reports.
   *
   * Entitlement and host-device availability are deliberately NOT driven from the plan here:
   * entitlement is already asserted directly above, with its own richer (payment-aware) error, and
   * host-device support can only be checked once the app's own compose is on disk — `buildInstallPlan`
   * runs before any install exists, so its `hostDevices` check is a no-op for a fresh install. See
   * `assertRequiredHostDevices` below, once `copyAppFromRepoToInstalled` has run.
   *
   * If building the plan itself throws — a marketplace lookup blip, a registry hiccup, anything
   * short of the plan actually reporting a failed check — that is not evidence the install is
   * invalid, only that this recheck couldn't run. Same stance `verifyAppArchitecture` already
   * takes when it cannot inspect an image (`null`, not a block): fail open and let the install
   * proceed on the strength of the checks `installApp` already ran at submission time, rather
   * than turning a would-succeed install into `install_failed` over this recheck's own failure.
   */
  private async assertPlanConfigAndArchitecture(appUrn: AppUrn, form: AppEventFormInput): Promise<void> {
    const { AppLifecycleService } = await import('../app-lifecycle.service');
    const appLifecycleService = this.moduleRef.get(AppLifecycleService, { strict: false });

    let plan: Awaited<ReturnType<typeof appLifecycleService.buildInstallPlan>> | undefined;
    try {
      plan = await appLifecycleService?.buildInstallPlan(appUrn, form);
    } catch (error) {
      const logger = this.moduleRef.get(LoggerService, { strict: false });
      logger?.warn(
        `[install] could not re-validate the install plan for ${appUrn}, proceeding without the recheck: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!plan) return;

    const failures = [
      plan.checks.config.ok ? null : `config (${plan.checks.config.reason ?? 'invalid'})`,
      plan.checks.architecture.ok ? null : `architecture (${plan.checks.architecture.reason ?? 'unsupported'})`,
    ].filter((reason): reason is string => reason !== null);

    if (failures.length > 0) {
      throw new AppLifecycleError(`Install of ${appUrn} is no longer valid: ${failures.join('; ')}`, { code: 'install_plan_blocked' });
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

  /**
   * Point the app at the host port of its main allocation: `APP_PORT` and the local URL variables in its
   * app.env, its base URLs, `form.port`, and the `port` column and `config` of its row. Every later
   * start, restart and update rebuilds app.env from the row's config, so a port kept only in app.env
   * would go back to the manifest's port on the next start.
   */
  private async applyMainHostPort(appUrn: AppUrn, form: AppEventFormInput, main: Pick<PortAllocation, 'hostPort' | 'containerPort'>): Promise<void> {
    const { hostPort } = main;
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const envUtils = this.moduleRef.get(EnvUtils, { strict: false });
    const config = this.moduleRef.get(ConfigurationService, { strict: false });
    const appsRepository = this.moduleRef.get(AppsRepository, { strict: false });

    const appEnvData = await appFilesManager.getAppEnv(appUrn);
    const envMap = envUtils.envStringToMap(appEnvData.content);
    // The port app.env pointed the app at until now: the form's or the manifest's on a first
    // allocation, the refused one on a move.
    const previousPort = Number(envMap.get('APP_PORT'));
    envMap.set('APP_PORT', String(hostPort));

    // Keep URL/origin vars aligned with generateEnvFile (browser host, not bind address).
    const bindHost = envMap.get('APP_HOSTNAME') || config.getConfig().internalIp;
    const browserHost = resolveBrowserHost(bindHost);
    const internalAuthority = `${browserHost}:${hostPort}`;
    envMap.set('APP_INTERNAL_AUTHORITY', internalAuthority);
    if (envMap.get('APP_EXPOSED') !== 'true') {
      envMap.set('APP_HOST', browserHost);
      envMap.set('APP_DOMAIN', internalAuthority);
      envMap.set('APP_URL', `http://${internalAuthority}`);
    }

    // The app's own base URLs: APP_BASE_URL, which generateEnvFile copies from APP_URL when the app
    // has no public address, and each `app_base_url` field, which the install dialog fills with
    // `http://localhost:<port>` (or the tailnet name and port) and config replays on every start.
    // One still naming the port the app left would send its redirects, sign-in callbacks and links to
    // whatever holds that port now. A public address names no port, so it stays as it is.
    const followsPort = Number.isInteger(previousPort) && previousPort !== hostPort;
    const follow = (value: unknown) => (followsPort && typeof value === 'string' ? withMovedPort(value, previousPort, hostPort) : value);
    const baseUrlFields = followsPort
      ? ((await appFilesManager.getInstalledAppInfo(appUrn))?.form_fields ?? []).filter((field) => field.type === 'app_base_url')
      : [];
    const baseUrlBefore = envMap.get('APP_BASE_URL');
    for (const envVar of ['APP_BASE_URL', ...baseUrlFields.flatMap((field) => [field.env_variable, ...(field.alias_env_variables ?? [])])]) {
      const value = envMap.get(envVar);
      if (value !== undefined) {
        envMap.set(envVar, follow(value) as string);
      }
    }
    const baseUrl = envMap.get('APP_BASE_URL');
    if (baseUrl && baseUrl !== baseUrlBefore) {
      try {
        const parsed = parseAppBaseUrl(baseUrl);
        envMap.set('APP_BASE_HOST', parsed.host);
        envMap.set('APP_BASE_WSS_ORIGIN', deriveAppBaseWsOrigin(parsed));
      } catch {
        // generateEnvFile leaves the derived pair alone for a base URL it cannot parse, and so does this.
      }
    }

    // Also update form.port so ensureAppDir uses the right port
    form.port = hostPort;

    await appFilesManager.writeAppEnv(appUrn, envUtils.envMapToString(envMap));

    const app = await appsRepository?.getAppByUrn(appUrn);
    if (!app) {
      return;
    }
    const storedConfig = (app.config ?? {}) as Record<string, unknown>;
    const nextConfig: Record<string, unknown> = { ...storedConfig, port: hostPort };
    for (const field of baseUrlFields) {
      if (storedConfig[field.env_variable] !== undefined) {
        nextConfig[field.env_variable] = follow(storedConfig[field.env_variable]);
      }
    }
    // A start rebuilds APP_PORT from config.port, or from the manifest's port (the container port)
    // when config has none, so that is the port to compare, not the row's port column alone.
    const portOnNextStart = storedConfig.port ?? main.containerPort;
    const baseUrlsMoved = baseUrlFields.some((field) => nextConfig[field.env_variable] !== storedConfig[field.env_variable]);
    if (app.port !== hostPort || portOnNextStart !== hostPort || baseUrlsMoved) {
      await appsRepository.updateAppById(app.id, { config: nextConfig, port: hostPort });
    }
  }

  /**
   * Move the app's main port when `compose up` failed because something already holds it on the
   * host, and report whether it moved. The port manager's probe runs inside the Hub container and
   * cannot see a program listening on the host itself (a locally run OpenClaw gateway on 18789,
   * say), so Docker's refusal is the first sign of it. `refused` collects every port Docker turned
   * down during this install, so a retry never lands on one of them again.
   *
   * Only the main port moves. A port from the manifest's `addPorts` is published as written, so a
   * conflict on one fails the install as before.
   */
  private async moveMainPortOffConflict(appUrn: AppUrn, form: AppEventFormInput, error: unknown, refused: Set<number>): Promise<boolean> {
    const portManager = this.moduleRef.get(PortManagerService, { strict: false });
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const conflict = extractConflictingHostBinding(error);
    // The main port is always TCP, so a UDP refusal on the same number is an `addPorts` mapping.
    if (!portManager || !conflict || conflict.protocol === 'udp' || (await portManager.getMainPort(appUrn)) !== conflict.port) {
      return false;
    }

    const { port } = conflict;
    refused.add(port);
    const moved = await portManager.moveMainPort(appUrn, refused);
    if (!moved) {
      return false;
    }

    logger.warn(`Host port ${port} for ${appUrn} is already in use on this computer; moving the app to port ${moved.hostPort}`);
    await this.applyMainHostPort(appUrn, form, moved);
    return true;
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
