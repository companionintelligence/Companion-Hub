import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { SSEService } from '@/core/sse/sse.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { getEffectiveExposureMode } from '@/modules/apps/app-exposure.helpers';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { AppVolumeArchiveService } from '@/modules/docker/app-volume-archive.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ImageSizeService } from '@/modules/marketplace/image-size.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { withTimeout } from '@/common/helpers/with-timeout';
import { AppLifecycleCommand, type CommandExecutionContext } from './command';
import type { AppCommandDeadline } from '@/common/helpers/app-command-deadline';
import { AppLifecycleError, type AppCommandResult } from './app-lifecycle-errors';
import { hostPortMoveOf } from './main-host-port';
import { pullAppImagesRecorded, uniqueServiceImages } from './pull-app-images';
import { removeAppDataWithPrivilegedFallback } from './remove-app-data';
import { isAbortError, throwIfAborted } from '@/common/abort';
import { type AppSecurityGrants, type HostPortMove, parseComposeJson } from '@ci-hub/common/schemas';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { securityGrantsFor } from '@/modules/apps/security-grants';
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

export function extractComposeImages(composeContent: unknown, grants?: AppSecurityGrants): string[] {
  const { services } = parseComposeJson(composeContent, grants);
  return uniqueServiceImages(services);
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

/** What the app already had on this Hub before an install wrote anything. A cancel leaves it there. */
type EarlierAppData = { files: boolean; volumes: boolean };

/** Both checks are local calls. A Docker engine or a disk that stops answering must not hold up the install queue. */
const EARLIER_DATA_CHECK_TIMEOUT_MS = 15_000;

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
      parseComposeJson(composeToInstallContent, securityGrantsFor(appUrn));
    } catch (err) {
      logger.error(`Error parsing docker-compose.yml for app ${appUrn} from marketplace repository. Are you running the latest version of CI Hub?`);
      return this.handleAppError(err, appUrn, 'update_error');
    }

    const refusedHostPorts = new Set<number>();
    // Read before this install writes anything: what is there now is data it must not take with it on a cancel.
    const earlierData = await this.readEarlierData(appUrn);

    try {
      ctx?.setPhase('preparing');
      await this.assertMarketplaceEntitlement(appUrn, 'install');
      await this.assertPlanConfigAndArchitecture(appUrn, form);
      const appImages = extractComposeImages(composeToInstallContent, securityGrantsFor(appUrn));
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
              portRequests.push(...buildComposePortRequests(composeJson.content, securityGrantsFor(appUrn)));
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
      // Not the volume folders yet: one made for a file a volume mounts (`data/config.yml`) would stop
      // copyDataDir below from copying the store's data folder. They are made after it (#2198).
      await this.ensureAppDir(appUrn, form, { createVolumeDirs: false });

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
        const filesystem = this.moduleRef.get(FilesystemService, { strict: false });
        const { appInstalledDir } = appFilesManager.getAppPaths(appUrn);
        const appRepoDir = path.join(directories.dataDir, 'repos', appStoreId, 'apps', appName);
        const targetDir = path.join(containerAppDataPath, 'data');
        if (!(await filesystem.createDirectory(targetDir))) {
          throw new Error(`Could not create ${targetDir} for the OpenClaw start scripts`);
        }

        // Helper: copy a file from the installed app payload to the data volume,
        // falling back to the provided content string if the source is absent.
        const ensureScript = async (filename: string, fallbackContent: string, fallbackWarning: string) => {
          const targetPath = path.join(targetDir, filename);
          const candidateSources = [path.join(appInstalledDir, 'data', filename), path.join(appRepoDir, 'data', filename)];
          let restoredFromSource = false;
          for (const sourcePath of candidateSources) {
            // A regular file only. These folders hold what a store's author shipped and what the app's
            // container wrote. The filesystem service keeps every step inside them.
            if (!(await filesystem.isFile(sourcePath))) {
              continue;
            }
            if (await filesystem.copyFile(sourcePath, targetPath)) {
              restoredFromSource = true;
              logger.info(`[OpenClaw] Restored ${filename} from ${sourcePath}`);
              break;
            }
            logger.warn(`[OpenClaw] Could not restore ${filename} from ${sourcePath}. Trying next source.`);
          }
          // The container's entrypoint: without it the install would report success and the app never start.
          if (!restoredFromSource && !(await filesystem.writeTextFile(targetPath, fallbackContent))) {
            throw new Error(`Could not write the OpenClaw start script ${targetPath}`);
          }
          if (!(await filesystem.makeExecutable(targetPath))) {
            throw new Error(`Could not make the OpenClaw start script ${targetPath} executable`);
          }
          if (!restoredFromSource) {
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
          ? await pullAppImagesRecorded(
              { docker: dockerService, files: appFilesManager, logger },
              appUrn,
              appImages,
              () =>
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
              { forced: forcePull },
            )
          : logger.warn(`Docker pull progress tracking is unavailable for ${appUrn}; falling back to compose up progress`);
      }

      // Entering compose-up. This remains cancellable; the abort kills `compose up` and compensation
      // tears down whatever was partially created.
      ctx?.setPhase('composing');
      throwIfAborted(ctx?.signal);

      await emitProgress(99);
      await this.composeUpRecordingPulls(appUrn, form, 'up --detach --force-recreate --remove-orphans', 3, ctx?.signal, {
        recoverHostPortConflict: (error) => this.moveMainPortOffConflict(appUrn, form, error, refusedHostPorts),
      });
      await appFilesManager.setAppDataDirPermissions(appUrn);

      // Honor a cancel that landed while `compose up` was running but still completed: install is a
      // "safe" tier op, so we abort + compensate (remove the just-created app) rather than finish.
      throwIfAborted(ctx?.signal);

      // Containers are up and the cancel window is closed — past the point of no return. Cancel is
      // refused beyond this phase (see AppLifecycleService.cancelOperation).
      ctx?.setPhase('finalizing');

      const notUp = await this.appCameUpError(appUrn);

      // Regenerate Traefik file-based config after app is installed and started. Also when a service
      // failed, since the other containers stay up and the status sync moves the app to `running` once
      // they all settle. The check above was the wait for the containers to start.
      if (getEffectiveExposureMode(form) !== 'local') {
        const traefikConfigService = this.moduleRef.get(TraefikConfigService, { strict: false });
        if (traefikConfigService) {
          logger.debug(`Regenerating Traefik config for newly installed exposed app ${appUrn}`);
          await traefikConfigService.regenerateTraefikConfig(0);
        }
      }

      // Register the agent wake webhook for MCP-client apps (R-HOOK-1). Also when a service failed: an
      // app the status sync brings to `running` goes through nothing else that would register it.
      //
      // The target is resolved by AgentNotifyService from what is on disk. Install and the startup
      // rehydration call the same code, so they cannot drift apart.
      try {
        const agentNotifyService = this.moduleRef.get(AgentNotifyService, { strict: false });
        const target = await agentNotifyService?.resolveWebhookTarget(appUrn);
        if (target) {
          agentNotifyService.registerWebhook(appUrn, target.url, target.token);
        }
      } catch (hookErr) {
        logger.warn(`Failed to register agent webhook for ${appUrn}: ${hookErr}`);
      }

      if (notUp) {
        throw notUp;
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
            const errorSummary = diagResults.unhealthy.map((c) => `${c.name} (${c.state})`).join('\n');
            const localDetails = diagResults.unhealthy.map((c) => `${c.name} (${c.state}): ${c.logs}`).join('\n');
            logger.warn(`[AppDiag] App ${appUrn} has unhealthy containers:\n${localDetails}`);

            const errorReportingService = this.moduleRef.get(ErrorReportingService, { strict: false });
            errorReportingService?.reportAppFailure({
              appUrn,
              phase: 'post_start',
              message: errorSummary,
              containers: diagResults.unhealthy.map(({ name, state }) => ({ name, state })),
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

      await emitProgress(99);
      const movedHostPort = hostPortMoveOf(form, refusedHostPorts);
      await this.markInstallSucceeded(appUrn, sseService, appsRepository, logger, movedHostPort);

      try {
        const mcpProbe = this.moduleRef.get(McpProbeService, { strict: false });
        mcpProbe?.scheduleProbe(appUrn);
      } catch (probeErr) {
        logger.debug(`MCP post-install probe not scheduled for ${appUrn}: ${probeErr}`);
      }

      return { success: true, message: `App ${appUrn} installed successfully`, movedHostPort };
    } catch (err) {
      // A user-requested cancel: tear down whatever was partially created and report a cancellation
      // (not a failure). The service finalizes the cancel (deletes the record + emits install_cancelled).
      if (isAbortError(err)) {
        return { success: false, cancelled: true, ...(await this.compensateInstallCancel(appUrn, earlierData, ctx?.deadline)) };
      }
      // The row, config and app.env stay on a port the run moved to, whatever failed after the move.
      return { ...(await this.handleAppError(err, appUrn, 'install')), movedHostPort: hostPortMoveOf(form, refusedHostPorts) };
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
   * What the app already had on this Hub before this install wrote anything: the data folder and named volumes an
   * uninstall with Delete all data off keeps. A folder left by an install that failed looks the same and counts too.
   * A check that fails or doesn't answer in time counts as data being there: a cancel then keeps something it could
   * have removed instead of removing what it had to keep.
   */
  private async readEarlierData(appUrn: AppUrn): Promise<EarlierAppData> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const present = async (what: string, check: () => Promise<boolean>): Promise<boolean> => {
      try {
        return await withTimeout(check(), EARLIER_DATA_CHECK_TIMEOUT_MS, 'no answer in time');
      } catch (err) {
        logger.warn(`Could not check ${appUrn} for ${what} from before this install, so a cancel will keep them: ${err}`);
        return true;
      }
    };

    const [files, volumes] = await Promise.all([
      present('app data', () => appFilesManager.hasAppData(appUrn)),
      present('named volumes', () => this.moduleRef.get(AppVolumeArchiveService, { strict: false }).hasProjectVolumes(appUrn)),
    ]);

    return { files, volumes };
  }

  /**
   * Best-effort cleanup after an install is cancelled mid-flight: tears down containers, project networks,
   * port allocations, the agent webhook and the app directory. The app's data and volumes go too unless they
   * were there before this install. Pulled images are intentionally kept: a re-install is faster and we never
   * force-remove an image another installed app might share. Every step is individually guarded and
   * idempotent; the compose-down runs WITHOUT the (now-aborted) signal so cleanup completes. The DB record
   * stays for the service to delete (see AppLifecycleService.handleCancelledResult).
   *
   * @param earlier What the app had before this install. Kept data is left exactly as it is, along with
   * anything this install added to it: the Hub cannot tell a file this install wrote from one kept
   * by an uninstall. A later install starts from the same place a completed one would.
   * @param deadline The time the command has left, which the root helper keeps to.
   * @returns A human-readable summary for the cancellation result. When the data this install made could not
   * be removed, also the warning the page shows, with where it is on the host.
   */
  private async compensateInstallCancel(
    appUrn: AppUrn,
    earlier: EarlierAppData,
    deadline?: AppCommandDeadline,
  ): Promise<{ message: string; warningCode?: string; warningDetail?: string }> {
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

    // Without `-v` below, the anonymous volumes of this install's containers would stay behind with nothing to
    // remove them. `rm -v` takes those and no named ones. It has to run first: `down` removes the containers
    // that say which volumes are theirs.
    if (earlier.volumes) {
      await dockerService
        .composeApp(appUrn, 'rm --force --stop -v')
        .catch((err) => logger.warn(`[install-cancel] removing the containers' anonymous volumes failed for ${appUrn} (continuing): ${err}`));
    }

    // Tear down whatever was partially created. `--rmi local` only removes locally-built images, so pulled
    // images stay. `-v` removes the app's named volumes as well as its anonymous ones, so it goes only when
    // there were no named volumes before this install. Otherwise it would delete what an uninstall kept.
    try {
      await dockerService.composeApp(appUrn, earlier.volumes ? 'down --remove-orphans --rmi local' : 'down --remove-orphans -v --rmi local');
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

    const folderRemoved = await appFilesManager.deleteAppFolder(appUrn).catch((err) => {
      logger.warn(`[install-cancel] deleteAppFolder failed for ${appUrn}: ${err}`);
      return false;
    });
    // A data folder that held files before this install is left exactly as it is: nothing is deleted from it and
    // root never gets to it. One this install made holds what its containers wrote, a database's files as its own
    // user among them, so those go through the root helper.
    let data: { removed: boolean; hostPath?: string } = { removed: true };
    if (earlier.files) {
      logger.info(`[install-cancel] leaving the data folder of ${appUrn}: it held data from before this install`);
    } else {
      data = await removeAppDataWithPrivilegedFallback(appFilesManager, dockerService, logger, appUrn, deadline).catch((err) => {
        logger.warn(`[install-cancel] removing the app data failed for ${appUrn}: ${err}`);
        return { removed: false };
      });
    }

    if (!folderRemoved || !data.removed) {
      const leftover = [folderRemoved ? null : 'app folder', data.removed ? null : 'app data'].filter(Boolean).join(' and ');
      logger.warn(
        `[install-cancel] the ${leftover} of ${appUrn} could not be fully removed; a disk remnant may remain${data.hostPath ? ` at ${data.hostPath}` : ''}`,
      );
      return {
        message: `Install of ${appUrn} was cancelled, but its ${leftover} could not be fully removed and may leave a remnant on disk`,
        warningCode: 'APP_INSTALL_CANCELLED_PARTIAL_REMNANT',
        ...(data.hostPath ? { warningDetail: data.hostPath } : {}),
      };
    }

    logger.info(`[install-cancel] compensation complete for ${appUrn}`);
    if (earlier.files || earlier.volumes) {
      return { message: `Install of ${appUrn} was cancelled; data from before this install was left in place` };
    }
    return { message: `Install of ${appUrn} was cancelled and cleaned up` };
  }

  private async markInstallSucceeded(
    appUrn: AppUrn,
    sseService: SSEService | undefined,
    appsRepository: AppsRepository | undefined,
    logger: LoggerService,
    movedHostPort: HostPortMove | undefined,
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
    sseService?.emit('app', { event: 'install_success', appUrn, appStatus: 'running', movedHostPort });
  }
}
