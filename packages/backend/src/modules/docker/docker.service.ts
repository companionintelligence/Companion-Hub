import { spawn } from 'node:child_process';
import path from 'node:path';
import { abortError, isAbortError, throwIfAborted } from '@/common/abort';
import { getAppDataHostPath, resolveAppDataHostRoot } from '@/common/helpers/app-data-path.helper';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import {
  DEFAULT_APP_COMPOSE_INACTIVITY_TIMEOUT_MS,
  DEFAULT_APP_COMPOSE_TIMEOUT_MINUTES,
  DEFAULT_APP_IMAGE_PULL_INACTIVITY_TIMEOUT_MS,
  DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES,
  DEFAULT_HUB_CONTAINER_NAME,
  DEFAULT_NETWORK_NAME,
} from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, InternalServerErrorException, Inject } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type Dockerode from 'dockerode';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsRepository } from '../apps/apps.repository';
import { DOCKERODE } from './constants';
import { DockerReadFacade, type ManagedAppContainerVerification } from './docker-read.facade';

export type { AppContainerRuntimeStats, AppNetworkTarget, ManagedAppContainerVerification } from './docker-read.facade';

const MANAGED_APP_STARTUP_MAX_ATTEMPTS = 6;
const MANAGED_APP_STARTUP_DELAY_MS = 2_000;

/** Grace period after SIGTERM before a cancelled `docker compose` child is force-killed with SIGKILL. */
const COMPOSE_CANCEL_SIGKILL_GRACE_MS = 5_000;
// Upper bound for the privileged uninstall-remnant cleanup helper (image pull + delete).
const PRIVILEGED_CLEANUP_TIMEOUT_MS = 120_000;

/**
 * Time-box for `docker compose up <service>`. Generous because `up` pulls the
 * image on demand (compose `pull_policy`) on a fresh host, so this bound must
 * cover a cold pull; a wedged/cold pull is killed and retried within it rather
 * than hanging provisioning forever. When the image is already cached, `up`
 * starts in seconds — far under this bound and with no registry round-trip.
 */
const COMPOSE_UP_TIMEOUT_MS = 300_000;
/** Attempts for the bounded `up`: a wedged first attempt is killed, then retried. */
const COMPOSE_OP_MAX_ATTEMPTS = 2;
/** After the SIGKILL grace, unblock the caller even if the child never exits. */
const PROCESS_EXIT_BACKSTOP_MS = 5_000;

interface DockerPullProgressDetail {
  current?: number;
  total?: number;
}

interface DockerPullProgressEventMessage {
  id?: string;
  status?: string;
  progressDetail?: DockerPullProgressDetail;
}

interface DockerPullLayerSnapshot {
  current: number;
  total: number;
  status: string;
}

export interface DockerPullProgressEvent {
  activeImage: string;
  completedBytes: number;
  totalBytes: number;
  completedImages: number;
  totalImages: number;
  stage: 'downloading' | 'extracting' | 'complete';
}

@Injectable()
export class DockerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly appFilesManager: AppFilesManager,
    private readonly filesystem: FilesystemService,
    private readonly appsRepository: AppsRepository,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly dockerReadFacade: DockerReadFacade,
  ) {}

  /**
   * Derive the Docker Compose project name used by CI-Hub for a given app URN.
   *
   * @param appUrn - App URN (for example, "my-app:store")
   * @returns Compose project name used for labels and docker compose --project-name
   */
  private getComposeProjectName(appUrn: AppUrn): string {
    return this.dockerReadFacade.getComposeProjectName(appUrn);
  }

  /**
   * Check if a Docker API error indicates the target resource no longer exists.
   *
   * @param error - Error thrown by Dockerode or command execution
   * @returns True when the error represents a missing resource (404/not found)
   */
  private isResourceMissingError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('no such') || message.includes('not found') || message.includes('404');
  }

  /**
   * Check if a Docker API error indicates the resource is currently in use.
   *
   * @param error - Error thrown by Dockerode or command execution
   * @returns True when the resource cannot be removed due to active references
   */
  private isResourceInUseError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('is being used') || message.includes('in use') || message.includes('has active endpoints');
  }

  public getAppRuntimeStats(...args: Parameters<DockerReadFacade['getAppRuntimeStats']>) {
    return this.dockerReadFacade.getAppRuntimeStats(...args);
  }

  public getHubRuntimeStats(...args: Parameters<DockerReadFacade['getHubRuntimeStats']>) {
    return this.dockerReadFacade.getHubRuntimeStats(...args);
  }

  public getAppNetworkTarget(...args: Parameters<DockerReadFacade['getAppNetworkTarget']>) {
    return this.dockerReadFacade.getAppNetworkTarget(...args);
  }

  public isContainerRunning(...args: Parameters<DockerReadFacade['isContainerRunning']>) {
    return this.dockerReadFacade.isContainerRunning(...args);
  }

  public getManagedAppContainerVerification(...args: Parameters<DockerReadFacade['getManagedAppContainerVerification']>) {
    return this.dockerReadFacade.getManagedAppContainerVerification(...args);
  }

  public diagnoseAppContainers(...args: Parameters<DockerReadFacade['diagnoseAppContainers']>) {
    return this.dockerReadFacade.diagnoseAppContainers(...args);
  }

  /**
   * Snapshot image IDs from all containers belonging to an app compose project.
   *
   * This is collected before compose down so cleanup can still remove pulled
   * images by immutable ID even if tag/ref resolution changes later.
   *
   * @param appUrn - App URN to inspect
   * @returns Unique list of Docker image IDs referenced by project containers
   */
  public async snapshotAppImageIds(appUrn: AppUrn): Promise<string[]> {
    const projectName = this.getComposeProjectName(appUrn);

    try {
      // Snapshot concrete image IDs from project containers before teardown so we
      // can still remove pulled images even if compose ref resolution changes.
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${projectName}`] },
      });

      return [...new Set(containers.map((container) => container.ImageID).filter(Boolean))];
    } catch (error) {
      this.logger.warn(`Failed to snapshot image IDs for ${appUrn}: ${error}`);
      return [];
    }
  }

  public async forceStopApp(appUrn: AppUrn, graceSeconds = 10): Promise<{ stopped: string[]; killed: string[] }> {
    const projectName = this.getComposeProjectName(appUrn);
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${projectName}`] },
    });

    const stopped: string[] = [];
    const killed: string[] = [];

    for (const container of containers) {
      const dockerContainer = this.docker.getContainer(container.Id);
      const name = container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12);

      if (container.State !== 'running') {
        continue;
      }

      try {
        await dockerContainer.stop({ t: graceSeconds });
        stopped.push(name);
      } catch (error) {
        this.logger.warn(`Graceful stop failed for ${name} (${appUrn}), escalating to kill: ${error}`);
        await dockerContainer.kill().catch((killError) => {
          throw new Error(`Failed to kill container ${name}: ${killError instanceof Error ? killError.message : String(killError)}`);
        });
        killed.push(name);
      }
    }

    return { stopped, killed };
  }

  /**
   * Remove Docker images associated with an app after uninstall.
   *
   * Image candidates come from both:
   * - pre-down container image snapshot IDs, and
   * - compose-labeled images (for locally built artifacts).
   *
   * Missing/in-use image errors are intentionally non-fatal so uninstall can
   * continue and finish application-level cleanup.
   *
   * @param appUrn - App URN being uninstalled
   * @param snapshotImageIds - Optional pre-down image IDs collected from containers
   */
  public async removeAppImages(appUrn: AppUrn, snapshotImageIds: string[] = []): Promise<void> {
    const projectName = this.getComposeProjectName(appUrn);

    const labeledImages = await this.docker.listImages({ filters: { label: [`com.docker.compose.project=${projectName}`] } }).catch((error) => {
      this.logger.warn(`Failed to list labeled images for ${appUrn}: ${error}`);
      return [];
    });

    // Merge container-derived IDs with compose-labeled built images for
    // best-effort cleanup across partial/failure states.
    const imageIds = new Set<string>([...snapshotImageIds, ...labeledImages.map((image) => image.Id)].filter(Boolean));

    for (const imageId of imageIds) {
      try {
        await this.docker.getImage(imageId).remove({ force: true });
      } catch (error) {
        // Missing/in-use resources are non-fatal during uninstall cleanup.
        if (this.isResourceMissingError(error) || this.isResourceInUseError(error)) {
          this.logger.warn(`Skipping image removal for ${imageId} (${appUrn}): ${error}`);
          continue;
        }

        this.logger.warn(`Failed to remove image ${imageId} for ${appUrn}: ${error}`);
      }
    }
  }

  /**
   * Remove app-owned Docker networks that remain after compose teardown.
   *
   * The shared CI-Hub network and external compose networks are skipped to
   * avoid deleting infrastructure or user-managed resources.
   * Missing/in-use network errors are intentionally non-fatal.
   *
   * @param appUrn - App URN being uninstalled
   */
  public async removeAppNetworks(appUrn: AppUrn): Promise<void> {
    const projectName = this.getComposeProjectName(appUrn);

    const networks = await this.docker.listNetworks({ filters: { label: [`com.docker.compose.project=${projectName}`] } }).catch((error) => {
      this.logger.warn(`Failed to list networks for ${appUrn}: ${error}`);
      return [];
    });

    for (const network of networks) {
      const networkName = network.Name;
      // Never remove the shared hub network during app-specific teardown.
      if (!networkName || networkName === DEFAULT_NETWORK_NAME) {
        continue;
      }

      const isExternal = network.Labels?.['com.docker.compose.network.external'] === 'true';
      // External networks are user/host managed and should be left untouched.
      if (isExternal) {
        continue;
      }

      try {
        await this.docker.getNetwork(network.Id).remove();
      } catch (error) {
        if (this.isResourceMissingError(error) || this.isResourceInUseError(error)) {
          this.logger.warn(`Skipping network removal for ${networkName} (${appUrn}): ${error}`);
          continue;
        }

        this.logger.warn(`Failed to remove network ${networkName} for ${appUrn}: ${error}`);
      }
    }
  }

  /**
   * Empty an app's data directory using a short-lived ROOT helper container, for the
   * one case the non-root Hub process cannot handle itself: files a container created
   * as root (e.g. MinIO's `.minio.sys`). The Docker daemon runs as root, so a throwaway
   * container can delete them; the Hub then removes the now-empty dir normally.
   *
   * Security (this is a root-privileged delete, so it is deliberately paranoid):
   *  - The target is recomputed from `appUrn` via {@link getAppDataHostPath} — NEVER a
   *    caller-supplied path — and validated to be exactly `{app-data-root}/{store}/{app}`
   *    with safe path segments; anything else is refused.
   *  - The container bind-mounts ONLY that one app's data dir (never a parent that holds
   *    sibling apps) and only empties it (`find -mindepth 1 -delete`).
   *  - `--rm` (no residue), `--network none` (no egress), `--user 0:0`, array args (no
   *    shell → no injection), and a hard timeout.
   *
   * Returns whether the helper reported success. Best-effort: any failure returns false
   * so the caller falls back to warning the user with a manual command.
   */
  public async removeAppDataDirAsRoot(appUrn: AppUrn): Promise<boolean> {
    const config = this.config.getConfig();
    const inputs = {
      ciHubAppDataPath: process.env.CI_HUB_APP_DATA_PATH,
      appDataPath: config.userSettings.appDataPath,
      rootFolderHost: config.rootFolderHost,
    };

    let hostAppDataDir: string;
    let appDataRoot: string;
    try {
      hostAppDataDir = getAppDataHostPath(appUrn, inputs);
      appDataRoot = resolveAppDataHostRoot(inputs);
    } catch (err) {
      this.logger.error(`[uninstall-cleanup] cannot resolve host app-data path for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    const { appName, appStoreId } = extractAppUrn(appUrn);
    const p = path.posix;
    const isSafeSegment = (segment: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment);
    const expected = p.join(appDataRoot, appStoreId, appName);

    // Refuse anything that is not EXACTLY {app-data-root}/{store}/{app}. This is what
    // bounds the root-privileged delete to a single app's own data directory.
    if (
      !isSafeSegment(appStoreId) ||
      !isSafeSegment(appName) ||
      p.normalize(appDataRoot) === '/' ||
      p.normalize(hostAppDataDir) !== p.normalize(expected) ||
      p.basename(hostAppDataDir) !== appName ||
      p.basename(p.dirname(hostAppDataDir)) !== appStoreId ||
      hostAppDataDir.split('/').filter(Boolean).length < 3
    ) {
      this.logger.error(`[uninstall-cleanup] refusing privileged delete for ${appUrn}: resolved path ${hostAppDataDir} failed validation`);
      return false;
    }

    const image = process.env.CI_HUB_CLEANUP_IMAGE || 'alpine:3.20';
    // Mount ONLY this app's data dir and empty it (never delete the mountpoint itself).
    const args = [
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '0:0',
      '-v',
      `${hostAppDataDir}:/target:rw`,
      image,
      'find',
      '/target',
      '-mindepth',
      '1',
      '-delete',
    ];

    this.logger.warn(`[uninstall-cleanup] emptying root-owned remnant in ${hostAppDataDir} via a privileged ${image} helper`);
    try {
      await this.runDockerCliCommand(args, PRIVILEGED_CLEANUP_TIMEOUT_MS);
      return true;
    } catch (err) {
      this.logger.error(`[uninstall-cleanup] privileged cleanup failed for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Run a one-off `docker <args>` CLI command (no shell), rejecting on non-zero exit or
   * timeout. Args MUST be a pre-split array so no value is shell-interpreted.
   */
  private runDockerCliCommand(args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: 'pipe' });
      const stderr: string[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
      child.on('error', (err) => finish(() => reject(err)));
      child.on('close', (code) =>
        finish(() => (code === 0 ? resolve() : reject(new Error(`docker ${args[0]} exited ${code}: ${stderr.join('').trim()}`)))),
      );
    });
  }

  /**
   * Get the base compose args for an app

   * @param {string} appUrn - App name
   */
  public getBaseComposeArgsApp = async (appUrn: AppUrn) => {
    let isCustomConfig = false;

    const appEnv = await this.appFilesManager.getAppEnv(appUrn);
    const args: string[] = ['--env-file', appEnv.path];

    // DB-only — avoid AppsReadService/Marketplace (closes Docker↔Marketplace import cycle).
    const app = await this.appsRepository.getAppByUrn(appUrn);
    const userConfigEnabled = app?.userConfigEnabled ?? true;

    // User custom env file
    const userEnvFile = await this.appFilesManager.getUserEnv(appUrn);
    if (userEnvFile.content && userConfigEnabled) {
      isCustomConfig = true;
      args.push('--env-file', userEnvFile.path);
    }

    args.push('--project-name', this.getComposeProjectName(appUrn));

    const composeFile = await this.appFilesManager.getDockerComposeYaml(appUrn);
    args.push('-f', composeFile.path);

    // User defined overrides
    const userComposeFile = await this.appFilesManager.getUserComposeFile(appUrn);
    if (userComposeFile.content && userConfigEnabled) {
      isCustomConfig = true;
      args.push('--file', userComposeFile.path);
    }

    return { args, isCustomConfig };
  };

  public getBaseComposeArgsHub = async () => {
    const { dataDir } = this.config.get('directories');
    const args: string[] = ['--env-file', path.join(dataDir, '.env')];
    const composeProjectName = process.env.CI_HUB_COMPOSE_PROJECT_NAME || 'ci-hub';

    args.push('--project-name', composeProjectName);

    const composeFile = path.join(dataDir, 'docker-compose.yml');
    args.push('-f', composeFile);

    // User defined overrides (support both new and legacy filenames)
    const hubComposeFile = path.join(dataDir, 'user-config', 'hub-compose.yml');
    const legacyComposeFile = path.join(dataDir, 'user-config', 'tipi-compose.yml');
    const userComposeFile = (await this.filesystem.pathExists(hubComposeFile)) ? hubComposeFile : legacyComposeFile;
    if (await this.filesystem.pathExists(userComposeFile)) {
      args.push('--file', userComposeFile);
    }

    return { args };
  };

  /**
   * Run a `docker compose` subcommand for an app. When `signal` is provided, an abort kills the
   * spawned compose process (SIGTERM then SIGKILL) and rejects with an `AbortError`.
   *
   * @param appUrn - App URN
   * @param command - The compose subcommand to execute (e.g. `up --detach`, `down --remove-orphans`)
   * @param signal - Optional abort signal to cancel the running compose process
   */
  public async composeApp(appUrn: AppUrn, command: string, signal?: AbortSignal) {
    let { args, isCustomConfig } = await this.getBaseComposeArgsApp(appUrn);
    args.push(...command.split(' '));
    args = args.filter(Boolean);

    // Get the compose file path to set as working directory
    // This ensures docker-compose resolves relative paths correctly
    const composeFile = await this.appFilesManager.getDockerComposeYaml(appUrn);
    const composeDir = path.dirname(composeFile.path);

    this.logger.info(`Running docker compose with args ${args.join(' ')} from directory ${composeDir}`);

    // Prefer docker compose (v2 plugin) over docker-compose (v1 binary) for better compatibility
    // Try docker compose first, fallback to docker-compose binary if needed
    try {
      await this.assertComposePluginAvailable();

      this.logger.debug('docker compose plugin is available, using it');
      // Use docker compose plugin (docker-cli is installed in the container)
      return this.runDockerCompose(['docker', 'compose', ...args], composeDir, isCustomConfig, signal);
    } catch (_error) {
      // A cancellation during the plugin probe must not be swallowed by the binary fallback.
      if (isAbortError(_error)) {
        throw _error;
      }
      // Fallback to docker-compose binary if docker compose plugin is not available
      this.logger.warn('docker compose plugin not available, falling back to docker-compose binary');
      return this.runDockerCompose(['docker-compose', ...args], composeDir, isCustomConfig, signal).catch((fallbackError: unknown) => {
        if (isAbortError(fallbackError)) {
          throw fallbackError;
        }
        const err = fallbackError as Error & { code?: string };
        throw new Error(`Both docker compose and docker-compose failed: ${err.message || String(fallbackError)}`);
      });
    }
  }

  private async imageExistsLocally(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch (error) {
      if (this.isResourceMissingError(error)) {
        return false;
      }
      throw error;
    }
  }

  private summarizePullLayers(layers: Map<string, DockerPullLayerSnapshot>): {
    completedBytes: number;
    totalBytes: number;
    stage: DockerPullProgressEvent['stage'];
  } {
    let completedBytes = 0;
    let totalBytes = 0;
    let hasExtractingLayer = false;
    let hasActiveLayer = false;

    for (const layer of layers.values()) {
      const total = Math.max(layer.total, layer.current);
      totalBytes += total;

      const normalizedStatus = layer.status.toLowerCase();
      const isComplete = normalizedStatus.includes('pull complete') || normalizedStatus.includes('already exists');
      const isExtracting = normalizedStatus.includes('extract');

      if (isExtracting) {
        hasExtractingLayer = true;
      }

      if (!isComplete) {
        hasActiveLayer = true;
      }

      completedBytes += isComplete ? total : Math.min(layer.current, total);
    }

    const stage: DockerPullProgressEvent['stage'] = hasActiveLayer ? (hasExtractingLayer ? 'extracting' : 'downloading') : 'complete';
    return { completedBytes, totalBytes, stage };
  }

  public async pullImages(
    imageRefs: string[],
    options: {
      forcePull?: boolean;
      onProgress?: (event: DockerPullProgressEvent) => void;
      signal?: AbortSignal;
      inactivityTimeoutMs?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    const { signal } = options;
    const uniqueImages = [...new Set(imageRefs.map((image) => image.trim()).filter(Boolean))];

    if (uniqueImages.length === 0) {
      return;
    }

    throwIfAborted(signal);

    // Timeouts must throw a normal Error (not AbortError) so install treats them as failure, not cancel.
    const controller = new AbortController();
    type PullTimeoutReason = 'inactivity' | 'overall';
    let timeoutReason: PullTimeoutReason | null = null;

    const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_APP_IMAGE_PULL_INACTIVITY_TIMEOUT_MS;
    const overallTimeoutMs = options.timeoutMs ?? DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES * 60 * 1000;

    let inactivityTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const armInactivityTimer = () => {
      if (inactivityTimer) {
        globalThis.clearTimeout(inactivityTimer);
      }
      inactivityTimer = globalThis.setTimeout(() => {
        if (!controller.signal.aborted) {
          timeoutReason = 'inactivity';
          this.logger.warn(`[pull-timeout] no progress for ${Math.round(inactivityTimeoutMs / 60000)}m — aborting pull`);
          controller.abort();
        }
      }, inactivityTimeoutMs);
      inactivityTimer.unref?.();
    };

    const overallTimer = globalThis.setTimeout(() => {
      if (!controller.signal.aborted) {
        timeoutReason = 'overall';
        this.logger.warn(`[pull-timeout] exceeded ${Math.round(overallTimeoutMs / 60000)}m overall budget — aborting pull`);
        controller.abort();
      }
    }, overallTimeoutMs);
    overallTimer.unref?.();

    const onCallerAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    if (signal?.aborted) {
      onCallerAbort();
    } else {
      signal?.addEventListener('abort', onCallerAbort, { once: true });
    }

    const pullSignal = controller.signal;
    armInactivityTimer();

    const completedImages = new Set<string>();
    const layerSnapshots = new Map<string, DockerPullLayerSnapshot>();

    const emitProgress = (activeImage: string, stageOverride?: DockerPullProgressEvent['stage']) => {
      armInactivityTimer();

      if (!options.onProgress) {
        return;
      }

      const summary = this.summarizePullLayers(layerSnapshots);
      options.onProgress({
        activeImage,
        completedBytes: summary.completedBytes,
        totalBytes: summary.totalBytes,
        completedImages: completedImages.size,
        totalImages: uniqueImages.length,
        stage: stageOverride ?? summary.stage,
      });
    };

    try {
      await Promise.all(
        uniqueImages.map(async (image) => {
          throwIfAborted(pullSignal);

          if (!options.forcePull && (await this.imageExistsLocally(image))) {
            completedImages.add(image);
            emitProgress(image, 'complete');
            return;
          }

          await new Promise<void>((resolve, reject) => {
            this.docker.pull(image, (pullError: Error | null, stream?: NodeJS.ReadableStream) => {
              if (pullError) {
                reject(pullError);
                return;
              }

              if (!stream) {
                reject(new Error(`Docker did not provide a pull stream for ${image}`));
                return;
              }

              const onAbort = () => {
                this.logger.warn(`[pull-cancel] destroying pull stream for ${image}`);
                (stream as NodeJS.ReadableStream & { destroy?: (err?: Error) => void }).destroy?.(abortError());
                reject(abortError());
              };
              if (pullSignal.aborted) {
                onAbort();
                return;
              }
              pullSignal.addEventListener('abort', onAbort, { once: true });
              const cleanupAbort = () => pullSignal.removeEventListener('abort', onAbort);

              const modem = (
                this.docker as Dockerode & {
                  modem?: {
                    followProgress?: (
                      stream: NodeJS.ReadableStream,
                      onFinished: (error: Error | null, output: unknown[]) => void,
                      onProgress?: (event: DockerPullProgressEventMessage) => void,
                    ) => void;
                  };
                }
              ).modem;

              if (!modem?.followProgress) {
                cleanupAbort();
                reject(new Error('Docker pull progress tracking is unavailable'));
                return;
              }

              modem.followProgress(
                stream,
                (followError) => {
                  cleanupAbort();
                  if (followError) {
                    reject(followError);
                    return;
                  }

                  completedImages.add(image);
                  emitProgress(image, 'complete');
                  resolve();
                },
                (event) => {
                  if (event?.id) {
                    const snapshot = layerSnapshots.get(event.id) ?? { current: 0, total: 0, status: '' };
                    const current = Math.max(snapshot.current, event.progressDetail?.current ?? snapshot.current);
                    const total = Math.max(snapshot.total, event.progressDetail?.total ?? snapshot.total, current);
                    layerSnapshots.set(event.id, {
                      current,
                      total,
                      status: event.status ?? snapshot.status,
                    });
                  }

                  emitProgress(image);
                },
              );
            });
          }).catch((error) => {
            if (isAbortError(error)) {
              throw error;
            }
            throw new Error(`Failed to pull image ${image}: ${error instanceof Error ? error.message : String(error)}`);
          });
        }),
      );
    } catch (error) {
      if (timeoutReason === 'inactivity') {
        throw new Error(
          `Image pull stalled with no progress for ${Math.round(inactivityTimeoutMs / 60000)} minutes. Check Docker/registry connectivity and retry.`,
        );
      }
      if (timeoutReason === 'overall') {
        throw new Error(
          `Image pull exceeded the ${Math.round(overallTimeoutMs / 60000)}-minute budget. Check Docker/registry connectivity and retry.`,
        );
      }
      throw error;
    } finally {
      if (inactivityTimer) {
        globalThis.clearTimeout(inactivityTimer);
      }
      globalThis.clearTimeout(overallTimer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  // Plugin availability doesn't change at runtime; probe once and reuse so
  // every compose operation doesn't pay for an extra process spawn.
  private composePluginAvailable?: Promise<void>;

  private assertComposePluginAvailable(): Promise<void> {
    if (!this.composePluginAvailable) {
      this.composePluginAvailable = new Promise<void>((resolve, reject) => {
        const testCmd = spawn('docker', ['compose', 'version'], { stdio: 'pipe' });
        testCmd.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`docker compose not available (exit code: ${code})`));
          }
        });
        testCmd.on('error', reject);
      });
      // A failed probe should not be cached forever — allow retry on the next call
      this.composePluginAvailable.catch(() => {
        this.composePluginAvailable = undefined;
      });
    }
    return this.composePluginAvailable;
  }

  private async runDockerCompose(command: string[], cwd: string, isCustomConfig: boolean, signal?: AbortSignal) {
    // Log the full command for debugging
    this.logger.debug(`Executing: ${command[0]} ${command.slice(1).join(' ')}`);

    if (!command[0]) {
      throw new Error('Command is empty');
    }

    // Bail out before spawning if the operation was already cancelled.
    throwIfAborted(signal);

    // The process is spawned against an internal signal (not the caller's directly) so a hung compose
    // command (unresponsive daemon, stuck volume/network) can be aborted on its own timeout without
    // that abort being misread as a user cancel — see the timeoutReason check below. Without this a
    // wedged `up`/`down` never resolves, holding the app in a transitional status (and, for install,
    // INSTALL_PIPELINE_MUTEX_KEY) forever — see DEFAULT_APP_COMPOSE_TIMEOUT_MINUTES.
    const controller = new AbortController();
    type ComposeTimeoutReason = 'inactivity' | 'overall';
    let timeoutReason: ComposeTimeoutReason | null = null;

    const inactivityTimeoutMs = DEFAULT_APP_COMPOSE_INACTIVITY_TIMEOUT_MS;
    const overallTimeoutMs = DEFAULT_APP_COMPOSE_TIMEOUT_MINUTES * 60 * 1000;

    let inactivityTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const armInactivityTimer = () => {
      if (inactivityTimer) {
        globalThis.clearTimeout(inactivityTimer);
      }
      inactivityTimer = globalThis.setTimeout(() => {
        if (!controller.signal.aborted) {
          timeoutReason = 'inactivity';
          this.logger.warn(`[compose-timeout] '${command.join(' ')}' produced no output for ${Math.round(inactivityTimeoutMs / 60000)}m — aborting`);
          controller.abort();
        }
      }, inactivityTimeoutMs);
      inactivityTimer.unref?.();
    };

    const overallTimer = globalThis.setTimeout(() => {
      if (!controller.signal.aborted) {
        timeoutReason = 'overall';
        this.logger.warn(`[compose-timeout] '${command.join(' ')}' exceeded ${Math.round(overallTimeoutMs / 60000)}m — aborting`);
        controller.abort();
      }
    }, overallTimeoutMs);
    overallTimer.unref?.();

    const onCallerAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    if (signal?.aborted) {
      onCallerAbort();
    } else {
      signal?.addEventListener('abort', onCallerAbort, { once: true });
    }
    armInactivityTimer();

    const composeSignal = controller.signal;

    // Passing `signal` makes Node send SIGTERM to the child on abort. `docker compose` can spawn its
    // own child (the compose plugin) that survives a SIGTERM to the wrapper, so we layer an explicit
    // SIGTERM->SIGKILL escalation on top to guarantee the process tree is torn down on cancel/timeout.
    const cmd = spawn(command[0], command.slice(1), {
      cwd, // Set working directory to compose file's directory
      signal: composeSignal,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    // Tracks actual process termination (the 'close' event). `cmd.killed` only reflects that a signal
    // was *sent* (it is true right after Node's `{ signal }` SIGTERM), so it cannot gate the escalation.
    let closed = false;
    let abortHandled = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      // Idempotent: may be invoked by the 'abort' event or by the immediate post-registration check.
      if (abortHandled) {
        return;
      }
      abortHandled = true;
      // Node's `{ signal }` already sent SIGTERM. Escalate to SIGKILL if the process tree (the compose
      // plugin can outlive a SIGTERM to the wrapper) hasn't actually exited within the grace period.
      this.logger.warn(
        `[compose-cancel] aborting '${command.join(' ')}' (pid=${cmd.pid}); SIGTERM sent, escalating to SIGKILL in ${COMPOSE_CANCEL_SIGKILL_GRACE_MS}ms if needed`,
      );
      sigkillTimer = setTimeout(() => {
        if (!closed) {
          this.logger.warn(`[compose-cancel] SIGKILL '${command.join(' ')}' (pid=${cmd.pid})`);
          cmd.kill('SIGKILL');
        }
      }, COMPOSE_CANCEL_SIGKILL_GRACE_MS);
    };
    composeSignal.addEventListener('abort', onAbort, { once: true });
    // Cover the race where the signal aborts between spawn() and listener registration: the 'abort'
    // event has already fired, so schedule the escalation now instead of missing it.
    if (composeSignal.aborted) {
      onAbort();
    }

    try {
      // `code` is null when the process is terminated by a signal — keep it nullable rather than
      // coercing, so a signal-kill is treated as a non-zero (failed) exit below, not a success.
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        cmd.on('error', (error: NodeJS.ErrnoException) => {
          // Ignore ONLY the AbortError that `spawn({ signal })` emits on cancel — the 'close' handler
          // then settles the promise (with the SIGKILL backstop), and rejecting here would let the
          // `finally` cancel the escalation prematurely. Any other error (ENOENT/ENOEXEC/…) must still
          // reject, even during an abort: if the process never started there is no 'close' event, so
          // swallowing it would leave the promise pending forever.
          if (isAbortError(error)) {
            return;
          }
          this.logger.error(`Failed to spawn ${command[0]}: ${error.message}`);
          if (error.code === 'ENOEXEC') {
            this.logger.error(`${command[0]} binary cannot be executed. This usually means the binary is corrupted or for the wrong architecture.`);
          }
          reject(error);
        });
        cmd.stdout.on('data', (data: Buffer | string) => {
          armInactivityTimer();
          this.logger.debug(`${command[0]}: ${String(data).trim()}`);
          stdout.push(String(data).trim());
        });
        cmd.stderr.on('data', (data: Buffer | string) => {
          armInactivityTimer();
          this.logger.debug(`${command[0]}: ${String(data).trim()}`);
          stderr.push(String(data).trim());
        });
        cmd.on('close', (code: number | null) => {
          closed = true;
          resolve(code);
        });
      });

      if (composeSignal.aborted) {
        // Our own stall/budget timeout fired: surface a plain failure, not a cancellation, so install
        // treats it as `install_failed` (and releases the pipeline mutex) rather than as a user cancel.
        if (timeoutReason === 'inactivity') {
          throw new Error(
            `'${command.join(' ')}' produced no output for ${Math.round(inactivityTimeoutMs / 60000)} minutes and was aborted. Check Docker daemon/network connectivity and retry.`,
          );
        }
        if (timeoutReason === 'overall') {
          throw new Error(
            `'${command.join(' ')}' exceeded the ${Math.round(overallTimeoutMs / 60000)}-minute budget and was aborted. Check Docker daemon/network connectivity and retry.`,
          );
        }
        // A non-zero exit caused by our own SIGTERM/SIGKILL (relayed from the caller's signal) is a
        // cancellation, not a config failure.
        throw abortError();
      }

      if (exitCode !== 0) {
        this.logger.info(`${command[0]} exited with code ${exitCode}`);
        if (isCustomConfig) {
          this.logger.warn('User-config detected, please make sure your configuration is correct before opening an issue');
        }
        // stderr can be empty (signal terminations, stdout-only tools) — fall back to a message that
        // still identifies the command and exit code instead of throwing `new Error(undefined)`.
        const stderrMessage = stderr.pop();
        throw new Error(stderrMessage || `${command.join(' ')} exited with code ${exitCode}`);
      }

      return { success: true, stdout: stdout.join(''), stderr: stderr.join('') };
    } finally {
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
      }
      composeSignal.removeEventListener('abort', onAbort);
      if (inactivityTimer) {
        globalThis.clearTimeout(inactivityTimer);
      }
      globalThis.clearTimeout(overallTimer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  public getLogsStream = async (maxLines: number, appUrn?: AppUrn) => {
    try {
      const { args } = appUrn ? await this.getBaseComposeArgsApp(appUrn) : await this.getBaseComposeArgsHub();

      const logArgs = ['logs', '--follow', '-n', maxLines.toString()];
      if (!appUrn) {
        logArgs.push(DEFAULT_HUB_CONTAINER_NAME);
      }
      args.push(...logArgs);

      const canUseDockerComposePlugin = await this.isDockerComposePluginAvailable();
      if (!canUseDockerComposePlugin) {
        this.logger.warn('docker compose plugin not available for logs, falling back to docker-compose binary');
      }

      const logs = canUseDockerComposePlugin
        ? spawn('docker', ['compose', ...args], { stdio: 'pipe' })
        : spawn('docker-compose', args, { stdio: 'pipe' });

      logs.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOEXEC') {
          this.logger.error('docker-compose binary cannot be executed. Please ensure docker compose plugin is available.');
        }
      });

      logs.on('error', () => {
        logs.kill('SIGINT');
      });

      if (!logs.stdout) {
        throw new InternalServerErrorException('Docker output stream not available');
      }

      return {
        on: logs.stdout.on.bind(logs.stdout),
        kill: () => logs.kill('SIGINT'),
      };
    } catch (error) {
      this.logger.error('Error getting log stream', error);
      throw new InternalServerErrorException('Error getting log stream');
    }
  };

  private async isDockerComposePluginAvailable() {
    const probe = spawn('docker', ['compose', 'version'], { stdio: 'ignore' });

    return await new Promise<boolean>((resolve) => {
      probe.on('close', (code) => {
        resolve(code === 0);
      });
      probe.on('error', () => {
        resolve(false);
      });
    });
  }

  public getLogsDownloadStream = async (appUrn?: AppUrn) => {
    try {
      const { args } = appUrn ? await this.getBaseComposeArgsApp(appUrn) : await this.getBaseComposeArgsHub();

      const logArgs = ['logs', '--no-color'];
      if (!appUrn) {
        logArgs.push(DEFAULT_HUB_CONTAINER_NAME);
      }
      args.push(...logArgs);

      const canUseDockerComposePlugin = await this.isDockerComposePluginAvailable();
      if (!canUseDockerComposePlugin) {
        this.logger.warn('docker compose plugin not available for log download, falling back to docker-compose binary');
      }

      const logs = canUseDockerComposePlugin
        ? spawn('docker', ['compose', ...args], { stdio: 'pipe' })
        : spawn('docker-compose', args, { stdio: 'pipe' });

      logs.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOEXEC') {
          this.logger.error('docker-compose binary cannot be executed. Please ensure docker compose plugin is available.');
        }
      });

      logs.on('error', () => {
        logs.kill('SIGINT');
      });

      if (!logs.stdout || !logs.stderr) {
        throw new InternalServerErrorException('Docker output stream not available');
      }

      return {
        stdout: logs.stdout,
        stderr: logs.stderr,
        kill: () => logs.kill('SIGINT'),
      };
    } catch (error) {
      this.logger.error('Error getting log download stream', error);
      throw new InternalServerErrorException('Error getting log download stream');
    }
  };

  /**
   * Get all exposed host ports for an app's containers
   * Uses docker compose port command to get actual mapped host ports
   * @param appUrn - The app URN
   * @returns Array of host port numbers that are exposed
   */
  public async getExposedPorts(appUrn: AppUrn): Promise<number[]> {
    try {
      // args is not used here but required to destructure if getBaseComposeArgsApp returns it
      // However, check what getBaseComposeArgsApp does. If it's just getting args, maybe we don't need to call it if we don't use args.
      // But maybe it has side effects or validates something?
      // Assuming we can just ignore it for now.
      await this.getBaseComposeArgsApp(appUrn);
      const composeFile = await this.appFilesManager.getDockerComposeYaml(appUrn);
      const _composeDir = path.dirname(composeFile.path);

      // Get all services from compose file
      const composeJson = await this.appFilesManager.getDockerComposeJson(appUrn);
      if (!composeJson.content) {
        this.logger.warn(`No compose JSON found for ${appUrn}`);
        return [];
      }

      const composeContent = composeJson.content as { services?: Record<string, { ports?: string[] }> };
      const services = composeContent.services || {};

      const exposedPorts: number[] = [];

      // For each service, get its exposed ports
      for (const [serviceName, serviceConfig] of Object.entries(services)) {
        if (!serviceConfig.ports || serviceConfig.ports.length === 0) {
          continue;
        }

        // Parse port mappings (format: "hostPort:containerPort" or "${VAR}:containerPort")
        for (const portMapping of serviceConfig.ports) {
          const [hostPortStr, containerPort] = portMapping.split(':');

          // Skip if hostPortStr is undefined or empty
          if (!hostPortStr) {
            continue;
          }

          // Try to resolve host port (might be a variable like ${APP_PORT})
          let hostPort: number | null = null;

          // If it's a number, use it directly
          const parsedPort = Number.parseInt(hostPortStr, 10);
          if (!Number.isNaN(parsedPort)) {
            hostPort = parsedPort;
          } else if (hostPortStr.startsWith('${') && hostPortStr.endsWith('}')) {
            // It's a variable, try to resolve from env
            const varName = hostPortStr.slice(2, -1);
            const appEnv = await this.appFilesManager.getAppEnv(appUrn);
            const envLines = appEnv.content?.split('\n') || [];

            for (const line of envLines) {
              const match = line.match(new RegExp(`^${varName}=(.+)$`));
              if (match?.[1]) {
                const value = match[1].trim();
                const portValue = Number.parseInt(value, 10);
                if (!Number.isNaN(portValue)) {
                  hostPort = portValue;
                  break;
                }
              }
            }
          }

          // If we still don't have a port, try docker compose port command
          if (hostPort === null && containerPort) {
            try {
              // Use docker compose port command to get actual mapped port
              const portResult = await this.composeApp(appUrn, `port ${serviceName} ${containerPort}`);
              const portOutput = portResult.stdout.trim();

              // Parse output format: "0.0.0.0:32768" or "::1:32768"
              if (portOutput) {
                const parts = portOutput.split(':');
                if (parts.length > 0) {
                  const lastPart = parts[parts.length - 1];
                  if (lastPart) {
                    const resolvedPort = Number.parseInt(lastPart, 10);
                    if (!Number.isNaN(resolvedPort)) {
                      hostPort = resolvedPort;
                    }
                  }
                }
              }
            } catch (error) {
              // Port command might fail if container isn't running yet - that's okay
              this.logger.debug(`Could not get port for service ${serviceName} (container may not be running): ${error}`);
            }
          }

          if (hostPort !== null && !exposedPorts.includes(hostPort)) {
            exposedPorts.push(hostPort);
          }
        }
      }

      return exposedPorts.sort((a, b) => a - b);
    } catch (error) {
      this.logger.error(`Error getting exposed ports for ${appUrn}:`, error);
      return [];
    }
  }

  /**
   * Restart a specific container by name using system docker command
   */
  public async restartContainer(containerName: string): Promise<void> {
    this.logger.info(`Restarting container: ${containerName}`);
    // NOT time-boxed: `docker restart` honors each container's stop_grace_period
    // (some apps configure 60-120s), and callers such as the app self-heal path
    // (apps.service.resolveAppAvailability) restart arbitrary containers. A short
    // bound would spuriously reject a slow-but-healthy restart while the daemon
    // completes it server-side. `docker restart` does not hang in practice.
    return new Promise((resolve, reject) => {
      const cmd = spawn('docker', ['restart', containerName]);

      cmd.on('close', (code) => {
        if (code === 0) {
          this.logger.info(`Container ${containerName} restarted successfully`);
          resolve();
        } else {
          this.logger.error(`Failed to restart container ${containerName}, exit code: ${code}`);
          reject(new Error(`Failed to restart container ${containerName}`));
        }
      });

      cmd.on('error', (err) => {
        this.logger.error(`Error spawning docker restart command: ${err}`);
        reject(err);
      });
    });
  }

  /**
   * Ensure a container is running, starting it via docker compose if needed.
   * Tries `docker restart` first; if the container doesn't exist, falls back to
   * `docker compose --profile <profile> up <service> -d` using the appropriate
   * compose file for the current environment.
   */
  public async ensureContainerRunning(containerName: string, opts: { composeFile: string; profile?: string }): Promise<void> {
    try {
      await this.restartContainer(containerName);
    } catch (error) {
      // restart fails when the container does not exist (the common case) but also
      // on a genuine restart error — surface the reason rather than always claiming
      // "not found", then fall back to bringing the service up via compose.
      this.logger.info(
        `Restart of ${containerName} failed (${error instanceof Error ? error.message : String(error)}); creating via docker compose...`,
      );
      await this.composeUpService(containerName, opts);
    }
  }

  /**
   * Spawn a process and reject if it does not finish within `timeoutMs`. On timeout
   * the child is sent SIGTERM, then SIGKILL after a short grace, so a wedged
   * `docker` / `docker compose` invocation (e.g. a stalled image pull) can never
   * hang the caller indefinitely.
   *
   * On timeout the rejection is normally deferred until the child exits (its
   * `close`), so a retry does not spawn a second process while the first is still
   * shutting down. A hard backstop guarantees the caller unblocks even if the
   * child never exits; in that near-impossible case a retry may briefly overlap
   * the still-alive child, but docker serializes the underlying daemon-side work
   * by image/container name, so the overlap is harmless.
   *
   * Note: like `runDockerCompose`, this kills only the `docker` CLI, not a
   * process group — the actual pull/create runs in dockerd and continues (and is
   * de-duplicated by the daemon), which is why a retry safely re-attaches to it.
   */
  private runProcessBounded(
    command: string,
    commandArgs: string[],
    spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv },
    timeoutMs: number,
    label: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Default stdio is 'pipe'; both streams are drained below so a chatty child
      // cannot block on a full pipe buffer and stall until the timeout.
      const cmd = spawn(command, commandArgs, spawnOptions);

      let stderr = '';
      let settled = false;
      let timedOut = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      let backstopTimer: ReturnType<typeof setTimeout> | undefined;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        timedOut = true;
        this.logger.error(`${label} exceeded ${timeoutMs}ms — terminating (SIGTERM)`);
        cmd.kill('SIGTERM');
        sigkillTimer = setTimeout(() => {
          if (!settled) {
            cmd.kill('SIGKILL');
          }
        }, COMPOSE_CANCEL_SIGKILL_GRACE_MS);
        sigkillTimer.unref?.();
        backstopTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          this.logger.error(`${label}: child did not exit after SIGKILL`);
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, COMPOSE_CANCEL_SIGKILL_GRACE_MS + PROCESS_EXIT_BACKSTOP_MS);
        backstopTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();

      const clearTimers = () => {
        clearTimeout(timer);
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
        }
        if (backstopTimer) {
          clearTimeout(backstopTimer);
        }
      };

      // Drain stdout (unused) and capture stderr so a full pipe cannot stall the child.
      // A 'data' listener puts the stream in flowing mode (equivalent to resume()).
      cmd.stdout?.on('data', () => undefined);
      cmd.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      cmd.on('close', (code) => {
        clearTimers();
        if (settled) {
          return;
        }
        settled = true;
        if (code === 0) {
          // A clean exit is a success even if the timeout had just fired and we
          // sent SIGTERM: the process finished on its own, so honor it rather than
          // reporting a spurious timeout (and triggering an unnecessary retry).
          resolve();
        } else if (timedOut) {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        } else {
          reject(new Error(`${label} failed (exit ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
        }
      });

      cmd.on('error', (err) => {
        clearTimers();
        if (settled) {
          return;
        }
        settled = true;
        reject(err);
      });
    });
  }

  /** Run `fn` up to `attempts` times (at least once), logging each failure; rejects with the last error. */
  private async retryAsync(fn: () => Promise<void>, attempts: number, label: string): Promise<void> {
    const total = Math.max(1, attempts);
    let lastError: unknown;
    for (let attempt = 1; attempt <= total; attempt += 1) {
      try {
        await fn();
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(`${label} attempt ${attempt}/${total} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${label} failed after ${total} attempts`);
  }

  private async composeUpService(serviceName: string, opts: { composeFile: string; profile?: string }): Promise<void> {
    const baseArgs = ['compose'];
    const runtimeComposeFile = path.join(this.config.get('directories').dataDir, 'docker-compose.yml');
    const spawnOptions: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: path.dirname(opts.composeFile) };

    if (opts.composeFile === runtimeComposeFile) {
      const envFilePath = this.config.get('envFilePath');
      baseArgs.push('--env-file', envFilePath);
      // Match the project name used by start.ts / package.json scripts so
      // compose attaches to the running stack instead of creating a new one.
      const composeProjectName = process.env.CI_HUB_COMPOSE_PROJECT_NAME || 'ci-hub';
      baseArgs.push('--project-name', composeProjectName);

      // When running inside the Hub container, docker compose resolves relative
      // binds (e.g. ./tunnel) against /data. The host daemon then interprets
      // those as /data/* on the host, which is not the real Hub data dir.
      // Point compose at the host project directory so relative binds resolve
      // to ROOT_FOLDER_HOST (for example /home/.../.local/share/companion-hub).
      const hostProjectDir = process.env.ROOT_FOLDER_HOST?.trim();
      if (hostProjectDir) {
        baseArgs.push('--project-directory', hostProjectDir);
      }

      // Override ENV_FILE to just the filename so compose's env_file
      // directive resolves correctly inside the container.
      spawnOptions.env = { ...process.env, ENV_FILE: path.basename(envFilePath) };
    }

    baseArgs.push('-f', opts.composeFile);

    if (opts.profile) {
      baseArgs.push('--profile', opts.profile);
    }

    // Bring the service up on a bounded, retried path. `up` pulls the image on
    // demand per the compose `pull_policy` (only when it is not already present),
    // so a cached/baked-in image starts instantly with no registry round-trip,
    // while a fresh host's cold pull runs inside COMPOSE_UP_TIMEOUT_MS. A wedged
    // pull/up no longer hangs forever: it is killed at the deadline and retried,
    // and completed image layers persist across attempts.
    const upArgs = [...baseArgs, 'up', serviceName, '-d', '--no-build', '--no-deps'];
    this.logger.info(`Running: docker ${upArgs.join(' ')}`);
    await this.retryAsync(
      () => this.runProcessBounded('docker', upArgs, spawnOptions, COMPOSE_UP_TIMEOUT_MS, `docker compose up ${serviceName}`),
      COMPOSE_OP_MAX_ATTEMPTS,
      `up ${serviceName}`,
    );
    this.logger.info(`Service ${serviceName} started successfully via docker compose`);
  }

  /**
   * Poll after compose up until labeled containers reach a stable running state,
   * or return the last failed verification.
   */
  public async waitForManagedAppContainersReady(
    appUrn: AppUrn,
    options?: { maxAttempts?: number; delayMs?: number },
  ): Promise<ManagedAppContainerVerification> {
    const maxAttempts = options?.maxAttempts ?? MANAGED_APP_STARTUP_MAX_ATTEMPTS;
    const delayMs = options?.delayMs ?? MANAGED_APP_STARTUP_DELAY_MS;

    let lastVerification: ManagedAppContainerVerification | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastVerification = await this.dockerReadFacade.getManagedAppContainerVerification(appUrn);
      if (lastVerification.ok) {
        return lastVerification;
      }

      const shouldRetry = attempt < maxAttempts && (lastVerification.appStatus === 'missing' || lastVerification.appStatus === 'stopped');
      if (!shouldRetry) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return lastVerification ?? (await this.dockerReadFacade.getManagedAppContainerVerification(appUrn));
  }
}
