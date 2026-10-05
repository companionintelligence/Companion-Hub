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
  HUB_CONTAINER_NAMES,
  HUB_MANAGED_LABEL,
  HUB_NETWORK_NAMES,
  LEGACY_HUB_CONTAINER_NAME,
  LEGACY_HUB_MANAGED_LABEL,
  hubContainerName,
} from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, InternalServerErrorException, Inject } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type Dockerode from 'dockerode';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsRepository } from '../apps/apps.repository';
import { APPLE_CONTAINER_ENGINE_NOTICE, isSocktainerVersion } from './container-engine';
import { DOCKERODE } from './constants';
import { DockerReadFacade, type ManagedAppContainerVerification } from './docker-read.facade';
import { listContainersMatchingAnyLabelSets, managedAppLabelSets } from './hub-container-query';
import { resolveEdgeHopAddress } from '../network/edge-hops';
import { DEFAULT_HUB_EDGE_TRAEFIK_IP, HUB_EDGE_NETWORK_NAME, TRAEFIK_CONTAINER_NAME } from '../network/network-constants';

export type { AppContainerRuntimeStats, AppNetworkTarget, ManagedAppContainerVerification } from './docker-read.facade';

export interface PreUpdateVolumeSnapshotResult {
  appUrn: AppUrn;
  snapshotId: string;
  timestamp: string;
  /** The folder holding everything this snapshot wrote, so it can be removed as one. */
  snapshotBaseDir?: string;
  snapshotPath?: string;
  /** Snapshot of the app's installed dir (docker-compose.yml, config.json, etc.) as it stood before the update overwrote it. */
  appFilesSnapshotPath?: string;
  volumes: Array<{
    name?: string;
    type: 'bind' | 'volume';
    source: string;
    destination?: string;
    snapshotTarget?: string;
  }>;
  success: boolean;
  error?: string;
}

export interface ContainerHealthProbeDetail {
  id: string;
  name: string;
  status: string;
  state: string;
  healthStatus: string | null;
  hasHealthCheck: boolean;
  exitCode: number | null;
  failingStreak?: number;
  log?: string[];
}

export interface ContainerHealthProbeResult {
  ok: boolean;
  healthy: boolean;
  containers: ContainerHealthProbeDetail[];
  message: string;
}

const HUB_APP_NETWORK_GAP = 'Not attaching the Hub to app networks';
const HUB_APP_NETWORK_CONSEQUENCE =
  'Services that are not on the shared Hub network cannot resolve ci-hub, so an app that calls Hub inference from such a service fails with ENOTFOUND.';

const MANAGED_APP_STARTUP_MAX_ATTEMPTS = 6;
const MANAGED_APP_STARTUP_DELAY_MS = 2_000;

/** Grace period between SIGTERM and SIGKILL for a canceled Compose child process. */
const COMPOSE_CANCEL_SIGKILL_GRACE_MS = 5_000;
// Bound privileged uninstall cleanup, including the helper image pull and deletion.
const PRIVILEGED_CLEANUP_TIMEOUT_MS = 120_000;

/**
 * Bounds `docker compose up <service>`.
 *
 * Compose can pull an image on demand according to `pull_policy`, so the limit
 * must accommodate a cold pull on a new host. Kill and retry a stalled pull
 * instead of blocking provisioning indefinitely. Cached images start without a
 * registry request and remain well below this limit.
 */
const COMPOSE_UP_TIMEOUT_MS = 300_000;
/** Allows one retry after the bounded `up` process stalls or fails. */
const COMPOSE_OP_MAX_ATTEMPTS = 2;
/** Unblocks the caller if a child remains after the SIGKILL grace period. */
const PROCESS_EXIT_BACKSTOP_MS = 5_000;

/** Returns whether Docker failed because the container network endpoint is stale. */
function isStaleContainerNetworkError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /network .+ not found/i.test(msg) || /failed to set up container networking/i.test(msg);
}

/**
 * Neither `docker compose` nor the standalone `docker-compose` binary runs, so a Hub stack service
 * can be neither created nor brought back to its compose definition.
 */
export class ComposeCliUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeCliUnavailableError';
  }
}

/**
 * The operator-facing text for {@link ComposeCliUnavailableError}.
 *
 * It names the symptom operators actually search for. A docker CLI without the compose plugin
 * parses `compose` as an unknown command and rejects the first flag after it, so the Hub logged
 * `docker compose up cloudflared failed (exit 125): unknown flag: --env-file` on beta-ms-a2 and
 * beta-red (2026-09-17), which reads like a Hub argument bug rather than a missing plugin.
 */
export function describeComposeCliUnavailable(input: { service: string; pluginDetail: string; standaloneDetail: string }): string {
  return (
    `Cannot start ${input.service}: no Docker Compose CLI works in this Hub. ` +
    `"docker compose version" failed (${input.pluginDetail}) and "docker-compose version" failed (${input.standaloneDetail}). ` +
    'A docker CLI without the compose plugin rejects every compose flag, which is what "unknown flag: --env-file" means. ' +
    'Install the Docker Compose v2 plugin where the Hub runs (the Hub image ships it at /usr/local/libexec/docker/cli-plugins/docker-compose), then restart the Hub.'
  );
}

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

/** The slice of a Docker network listing this Hub needs to join or leave an app network. */
interface AppProjectNetwork {
  Id?: string;
  Name?: string;
  Labels?: Record<string, string> | null;
}

@Injectable()
export class DockerService {
  /** Whether the engine is Apple container, once probed. Fixed for the process: DOCKERODE is built once. */
  private appleContainerEngine: boolean | undefined;
  /** Gaps already warned about, so a periodic caller logs each once. */
  private readonly warnedAppleContainerGaps = new Set<string>();

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
   * Derives the Docker Compose project name for an app URN.
   *
   * @param appUrn App URN, such as `my-app:store`.
   * @returns Project name used for labels and `docker compose --project-name`.
   */
  private getComposeProjectName(appUrn: AppUrn): string {
    return this.dockerReadFacade.getComposeProjectName(appUrn);
  }

  /**
   * Returns whether a Docker API error indicates a missing resource.
   *
   * @param error Error from Dockerode or command execution.
   */
  private isResourceMissingError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('no such') || message.includes('not found') || message.includes('404');
  }

  /**
   * Returns whether a Docker API error indicates active resource references.
   *
   * @param error Error from Dockerode or command execution.
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
   * Captures image IDs from all containers in an app's Compose project.
   *
   * Capture these immutable IDs before `compose down` so cleanup can remove
   * pulled images even if tag or reference resolution changes later.
   *
   * @param appUrn App URN to inspect.
   * @returns Unique Docker image IDs referenced by project containers.
   */
  public async snapshotAppImageIds(appUrn: AppUrn): Promise<string[]> {
    const projectName = this.getComposeProjectName(appUrn);

    try {
      // Capture concrete IDs before teardown because Compose references can resolve
      // differently after the containers are removed.
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
   * Removes Docker images associated with an uninstalled app.
   *
   * Candidates include image IDs captured before teardown and Compose-labeled
   * images for local builds. Missing or in-use images do not fail the uninstall,
   * allowing application-level cleanup to finish.
   *
   * @param appUrn App URN being uninstalled.
   * @param snapshotImageIds Image IDs captured before container teardown.
   */
  public async removeAppImages(appUrn: AppUrn, snapshotImageIds: string[] = []): Promise<void> {
    const projectName = this.getComposeProjectName(appUrn);

    const labeledImages = await this.docker.listImages({ filters: { label: [`com.docker.compose.project=${projectName}`] } }).catch((error) => {
      this.logger.warn(`Failed to list labeled images for ${appUrn}: ${error}`);
      return [];
    });

    // Combine container IDs with Compose-labeled builds so cleanup covers partial
    // installation and teardown states.
    const imageIds = new Set<string>([...snapshotImageIds, ...labeledImages.map((image) => image.Id)].filter(Boolean));

    for (const imageId of imageIds) {
      try {
        await this.docker.getImage(imageId).remove({ force: true });
      } catch (error) {
        // Missing or in-use images must not block the remaining uninstall cleanup.
        if (this.isResourceMissingError(error) || this.isResourceInUseError(error)) {
          this.logger.warn(`Skipping image removal for ${imageId} (${appUrn}): ${error}`);
          continue;
        }

        this.logger.warn(`Failed to remove image ${imageId} for ${appUrn}: ${error}`);
      }
    }
  }

  /**
   * Removes app-owned Docker networks that remain after Compose teardown.
   *
   * Preserve the shared Companion Hub network and external Compose networks to
   * protect infrastructure and user-managed resources. Missing or in-use network
   * errors remain nonfatal.
   *
   * @param appUrn App URN being uninstalled.
   */
  public async removeAppNetworks(appUrn: AppUrn): Promise<void> {
    // The Hub joins each app network so every container can resolve `ci-hub`. That endpoint keeps
    // the network alive through `compose down`, so drop it before deleting the network ourselves.
    await this.detachHubFromAppNetworks(appUrn);

    const projectName = this.getComposeProjectName(appUrn);

    const networks = await this.docker.listNetworks({ filters: { label: [`com.docker.compose.project=${projectName}`] } }).catch((error) => {
      this.logger.warn(`Failed to list networks for ${appUrn}: ${error}`);
      return [];
    });

    for (const network of networks) {
      const networkName = network.Name;
      // Preserve the shared Hub network during app-specific teardown.
      if (!networkName || HUB_NETWORK_NAMES.includes(networkName as (typeof HUB_NETWORK_NAMES)[number])) {
        continue;
      }

      const isExternal = network.Labels?.['com.docker.compose.network.external'] === 'true';
      // Preserve external networks because users or the host manage them.
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
   * Empties an app data directory through a short-lived root helper container.
   *
   * The non-root Hub process cannot delete files that an app created as root,
   * such as MinIO's `.minio.sys`. The root Docker daemon can remove those files
   * through a temporary container, after which the Hub removes the empty directory.
   *
   * The privileged deletion uses these safeguards:
   *
   * - Recompute the target from `appUrn` with {@link getAppDataHostPath}; never
   *   accept a caller-supplied path. Require the exact
   *   `{app-data-root}/{store}/{app}` structure with safe path segments.
   * - Bind-mount only that app's directory, never a parent containing sibling
   *   apps, and remove only its contents with `find -mindepth 1 -delete`.
   * - Use `--rm`, `--network none`, `--user 0:0`, argument arrays without a
   *   shell, and a hard timeout.
   *
   * @returns Whether the helper succeeded. A failure returns `false` so the
   * caller can provide a manual cleanup command.
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

    // Require the exact `{app-data-root}/{store}/{app}` path to confine the
    // privileged deletion to one app directory.
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
    // Mount only this app directory and preserve the mount point itself.
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
   * Runs a one-time `docker <args>` command without a shell.
   *
   * Arguments must already be split so no value receives shell interpretation.
   * The promise rejects on a nonzero exit or timeout.
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
   * Builds the base Docker Compose arguments for an app.
   *
   * @param appUrn App URN.
   */
  public getBaseComposeArgsApp = async (appUrn: AppUrn) => {
    let isCustomConfig = false;

    const appEnv = await this.appFilesManager.getAppEnv(appUrn);
    const args: string[] = ['--env-file', appEnv.path];

    // Read the database directly to avoid a Docker-to-Marketplace import cycle
    // through `AppsReadService`.
    const app = await this.appsRepository.getAppByUrn(appUrn);
    const userConfigEnabled = app?.userConfigEnabled ?? true;

    // Include user environment overrides only when custom configuration is enabled.
    const userEnvFile = await this.appFilesManager.getUserEnv(appUrn);
    if (userEnvFile.content && userConfigEnabled) {
      isCustomConfig = true;
      args.push('--env-file', userEnvFile.path);
    }

    args.push('--project-name', this.getComposeProjectName(appUrn));

    const composeFile = await this.appFilesManager.getDockerComposeYaml(appUrn);
    args.push('-f', composeFile.path);

    // Include user Compose overrides only when custom configuration is enabled.
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

    // Support the current and legacy filenames for user Compose overrides.
    const hubComposeFile = path.join(dataDir, 'user-config', 'hub-compose.yml');
    const legacyComposeFile = path.join(dataDir, 'user-config', 'cihub-compose.yml');
    const userComposeFile = (await this.filesystem.pathExists(hubComposeFile)) ? hubComposeFile : legacyComposeFile;
    if (await this.filesystem.pathExists(userComposeFile)) {
      args.push('--file', userComposeFile);
    }

    return { args };
  };

  /**
   * Runs a Docker Compose subcommand for an app.
   *
   * When `signal` aborts, terminate the child with SIGTERM, escalate to SIGKILL
   * after the grace period, and reject with an `AbortError`.
   *
   * @param appUrn App URN.
   * @param command Compose subcommand, such as `up --detach`.
   * @param signal Optional signal that cancels the Compose process.
   */
  public async composeApp(appUrn: AppUrn, command: string, signal?: AbortSignal) {
    const verb = command.trim().split(/\s+/)[0];
    // Detach first. `compose down` with the Hub still attached exits 0, logs "Resource is still in
    // use", and leaves the network behind.
    if (verb === 'down') {
      await this.detachHubFromAppNetworks(appUrn);
    }

    let { args, isCustomConfig } = await this.getBaseComposeArgsApp(appUrn);
    args.push(...command.split(' '));
    args = args.filter(Boolean);

    // Run from the Compose file directory so relative paths resolve correctly.
    const composeFile = await this.appFilesManager.getDockerComposeYaml(appUrn);
    const composeDir = path.dirname(composeFile.path);

    this.logger.info(`Running docker compose with args ${args.join(' ')} from directory ${composeDir}`);

    // Prefer the Docker Compose v2 plugin and fall back to the v1 binary for
    // compatibility with hosts that do not provide the plugin. The probe is the only thing this
    // catch owns: a compose failure after a working plugin must surface as itself, not as a second
    // attempt with the v1 binary.
    let composeCommand: string[];
    try {
      await this.assertComposePluginAvailable();
      this.logger.debug('docker compose plugin is available, using it');
      composeCommand = ['docker', 'compose', ...args];
    } catch (_error) {
      // Propagate cancellation instead of starting the fallback binary.
      if (isAbortError(_error)) {
        throw _error;
      }
      this.logger.warn('docker compose plugin not available, falling back to docker-compose binary');
      composeCommand = ['docker-compose', ...args];
    }

    const result = await this.runDockerCompose(composeCommand, composeDir, isCustomConfig, signal).catch((fallbackError: unknown) => {
      if (composeCommand[0] === 'docker') {
        throw fallbackError;
      }
      if (isAbortError(fallbackError)) {
        throw fallbackError;
      }
      const err = fallbackError as Error & { code?: string };
      throw new Error(`Both docker compose and docker-compose failed: ${err.message || String(fallbackError)}`);
    });
    if (verb === 'up') {
      await this.attachHubToAppNetworks(appUrn);
    }
    return result;
  }

  /** Read-only cache lookup — never pulls. Also used by install plan preview (no mutation). */
  async imageExistsLocally(image: string): Promise<boolean> {
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

    // Report timeouts as ordinary errors so installation records a failure rather
    // than a user cancellation.
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

  // Cache plugin availability because it does not change during the process, and
  // avoid spawning a probe for every Compose operation.
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
      // Clear failed probes so a later call can detect a recovered plugin.
      this.composePluginAvailable.catch(() => {
        this.composePluginAvailable = undefined;
      });
    }
    return this.composePluginAvailable;
  }

  private async runDockerCompose(command: string[], cwd: string, isCustomConfig: boolean, signal?: AbortSignal) {
    // Include the complete command in diagnostics.
    this.logger.debug(`Executing: ${command[0]} ${command.slice(1).join(' ')}`);

    if (!command[0]) {
      throw new Error('Command is empty');
    }

    // Avoid spawning a child for an operation that is already canceled.
    throwIfAborted(signal);

    // Use an internal signal so a stalled Compose command can time out without
    // being misclassified as a user cancellation. Otherwise, an unresponsive
    // daemon or stuck volume or network operation can leave the app in a
    // transitional state and hold `INSTALL_PIPELINE_MUTEX_KEY` indefinitely.
    // See `DEFAULT_APP_COMPOSE_TIMEOUT_MINUTES`.
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

    // Passing `signal` makes Node send SIGTERM to the child on abort. The Compose
    // plugin can outlive its Docker CLI wrapper, so add explicit SIGKILL
    // escalation to terminate the process tree after cancellation or timeout.
    const cmd = spawn(command[0], command.slice(1), {
      cwd, // Set working directory to compose file's directory
      signal: composeSignal,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    // Track the `close` event because `cmd.killed` indicates only that Node sent a
    // signal. It becomes true before the process exits and cannot gate escalation.
    let closed = false;
    let abortHandled = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      // Keep this idempotent because the abort event and post-registration check
      // can both invoke it.
      if (abortHandled) {
        return;
      }
      abortHandled = true;
      // Node has already sent SIGTERM through `{ signal }`. Escalate if the
      // Compose process tree remains after the grace period.
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
    // If the signal aborts between `spawn()` and listener registration, the event
    // has already fired. Start escalation explicitly to close that race.
    if (composeSignal.aborted) {
      onAbort();
    }

    try {
      // Preserve a `null` exit code for signal termination so the process cannot
      // be mistaken for a successful zero exit.
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        cmd.on('error', (error: NodeJS.ErrnoException) => {
          // Ignore only the `AbortError` emitted by `spawn({ signal })`. The
          // `close` handler settles cancellation with the SIGKILL backstop;
          // rejecting here would let `finally` cancel escalation too early. Reject
          // every other error, including during abort, because a process that
          // never started emits no `close` event and would leave the promise pending.
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
        // Report internal stall and budget timeouts as failures so installation
        // records `install_failed` and releases the pipeline mutex instead of
        // treating them as user cancellations.
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
        // A nonzero exit caused by the caller's relayed SIGTERM or SIGKILL is a
        // cancellation, not a configuration failure.
        throw abortError();
      }

      if (exitCode !== 0) {
        this.logger.info(`${command[0]} exited with code ${exitCode}`);
        if (isCustomConfig) {
          this.logger.warn('User-config detected, please make sure your configuration is correct before opening an issue');
        }
        // Signal termination and stdout-only tools can leave stderr empty. Fall
        // back to the command and exit code instead of throwing an empty error.
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
        logArgs.push(hubContainerName());
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
        logArgs.push(hubContainerName());
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
   * Returns exposed host ports for an app's containers.
   *
   * Docker Compose resolves dynamically assigned port mappings when the manifest
   * or app environment does not provide a concrete host port.
   *
   * @param appUrn App URN.
   */
  public async getExposedPorts(appUrn: AppUrn): Promise<number[]> {
    try {
      // Preserve the existing app configuration read before inspecting its Compose file.
      await this.getBaseComposeArgsApp(appUrn);
      const composeFile = await this.appFilesManager.getDockerComposeYaml(appUrn);
      const _composeDir = path.dirname(composeFile.path);

      // Read service declarations to discover their port mappings.
      const composeJson = await this.appFilesManager.getDockerComposeJson(appUrn);
      if (!composeJson.content) {
        this.logger.warn(`No compose JSON found for ${appUrn}`);
        return [];
      }

      const composeContent = composeJson.content as { services?: Record<string, { ports?: string[] }> };
      const services = composeContent.services || {};

      const exposedPorts: number[] = [];

      // Resolve each declared mapping to a concrete host port.
      for (const [serviceName, serviceConfig] of Object.entries(services)) {
        if (!serviceConfig.ports || serviceConfig.ports.length === 0) {
          continue;
        }

        // Port mappings use `hostPort:containerPort` or `${VAR}:containerPort`.
        for (const portMapping of serviceConfig.ports) {
          const [hostPortStr, containerPort] = portMapping.split(':');

          // Ignore mappings without an explicit host-side segment.
          if (!hostPortStr) {
            continue;
          }

          // Resolve either a numeric port or an environment reference.
          let hostPort: number | null = null;

          // Numeric host ports need no environment lookup.
          const parsedPort = Number.parseInt(hostPortStr, 10);
          if (!Number.isNaN(parsedPort)) {
            hostPort = parsedPort;
          } else if (hostPortStr.startsWith('${') && hostPortStr.endsWith('}')) {
            // Resolve variable mappings, such as `${APP_PORT}`, from `app.env`.
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

          // Ask Compose for the runtime mapping when static resolution is insufficient.
          if (hostPort === null && containerPort) {
            try {
              // Compose reports the host address and dynamically assigned port.
              const portResult = await this.composeApp(appUrn, `port ${serviceName} ${containerPort}`);
              const portOutput = portResult.stdout.trim();

              // Parse address formats such as `0.0.0.0:32768` and `::1:32768`.
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
              // A container that has not started yet has no runtime port mapping.
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

  /** Restarts a named container through the system Docker CLI. */
  public async restartContainer(containerName: string): Promise<void> {
    this.logger.info(`Restarting container: ${containerName}`);
    // Do not time-box `docker restart`. It honors each container's
    // `stop_grace_period`, which some apps set to 60–120 seconds, and callers such
    // as `AppsService.resolveAppAvailability` restart arbitrary containers. A
    // short limit would reject healthy restarts while the daemon completes them.
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
   * Brings a Hub stack service to its current compose definition and makes sure it runs.
   *
   * `compose up <service>` runs first, not `docker restart`. Compose compares the container's
   * `com.docker.compose.config-hash` label with the file, so it leaves an unchanged running
   * container alone, starts a stopped one, and replaces one created from an older definition.
   * `docker restart` only restarts whatever exists. On beta-max (2026-09-17) the cloudflared
   * container had been created on 2026-09-08 with its token mount at `<data dir>/tunnel`; the
   * compose file has since moved that mount to `<data dir>/../tunnel`, where the Hub writes the
   * token. The Hub boot logged "Container cloudflared restarted successfully", and the container
   * kept exiting 255 on "Failed to read token file" (restart count 46 when inspected) while the
   * public hostname returned 530.
   *
   * Pass `forceRecreate` after rewriting a file the service reads only at startup, such as the
   * tunnel token. The definition is unchanged in that case, so compose alone would keep the old
   * process.
   *
   * If stale networking blocks startup, remove the container and force-create it. If no compose
   * CLI works at all, restart the existing container so a stopped tunnel still comes back, and
   * log why its definition could not be checked.
   */
  public async ensureContainerRunning(
    containerName: string,
    opts: { composeFile: string; profile?: string; forceRecreate?: boolean },
  ): Promise<void> {
    try {
      await this.composeUpService(containerName, opts);
    } catch (upError) {
      if (upError instanceof ComposeCliUnavailableError) {
        this.logger.error(upError.message);
        try {
          await this.restartContainer(containerName);
        } catch {
          // A missing container cannot be restarted; the compose diagnosis is the useful error.
          throw upError;
        }
        this.logger.warn(`Restarted the existing ${containerName} container without checking it against the compose file.`);
        return;
      }
      // After `compose down` recreates a network, an exited container can retain
      // the deleted network ID. Remove and force-create that container when plain
      // `compose up` fails with a stale-network error.
      if (!isStaleContainerNetworkError(upError)) {
        throw upError;
      }
      this.logger.warn(
        `compose up ${containerName} failed with stale networking (${upError instanceof Error ? upError.message : String(upError)}); removing container and force-recreating...`,
      );
      // A failed removal still lets the force-recreate below report the real error.
      await this.removeContainer(containerName);
      await this.composeUpService(containerName, { ...opts, forceRecreate: true });
    }
  }

  /**
   * Joins this Hub to an app's own networks after a successful `up`.
   *
   * Apps are handed inference at `http://ci-hub:<port>/...`. That name exists only on a network the
   * Hub container is attached to. Compose puts a service on the shared Hub network only when it is
   * `isMain` or `addToMainNetwork`, so a sibling that calls inference (Companion Memory's `api` and
   * `summary-service`) cannot resolve `ci-hub`. Joining the Hub to the app network fixes that
   * without publishing the app's service names on the network every other app shares.
   *
   * `GwPriority: -1` keeps the Hub's default route on the network it booted with. A network connected
   * to a running container otherwise takes the route over when it sorts first (Docker 29.8), and the
   * Hub's own calls would then leave from the app subnet. No static address: DNS is the whole of
   * what callers need, and the app subnet is allocated per install.
   *
   * An `internal` app network is left alone. That flag is complete isolation; joining the Hub would
   * give those containers a path to the Hub API. `disableMainNetwork` without `internal` is joined:
   * those services are off the shared network and this is how they reach inference.
   *
   * Never throws. A failed attach leaves the app as it was before this fix, which is the failure
   * the operator already has, and must not fail the `up` that just succeeded.
   */
  public async attachHubToAppNetworks(appUrn: AppUrn): Promise<void> {
    if (await this.skipsNetworkHotAttach(HUB_APP_NETWORK_GAP, HUB_APP_NETWORK_CONSEQUENCE)) {
      return;
    }
    if (!(await this.runningHubContainerName())) {
      return;
    }
    await this.joinHubToAppNetworks(await this.listComposeProjectNetworks(appUrn));
  }

  /**
   * Whether Hub runs on Apple container (socktainer) rather than Docker, read from `GET /version`.
   *
   * An unreachable daemon is not an answer: this returns false without remembering it, so the next
   * call asks again instead of pinning the wrong engine for the life of the process.
   */
  public async isAppleContainerEngine(): Promise<boolean> {
    if (this.appleContainerEngine !== undefined) {
      return this.appleContainerEngine;
    }
    let apple: boolean;
    try {
      apple = isSocktainerVersion(await this.docker.version());
    } catch {
      return false;
    }
    // Two first calls can both reach here; the first to resume records the answer and warns.
    if (this.appleContainerEngine === undefined) {
      this.appleContainerEngine = apple;
      if (apple) {
        this.logger.warn(APPLE_CONTAINER_ENGINE_NOTICE);
      }
    }
    return this.appleContainerEngine;
  }

  /**
   * True, with one warning per `gap`, when the engine cannot attach a running container to a network.
   *
   * socktainer answers `network connect` and `disconnect` with success and changes nothing: Apple
   * container fixes a container's networks when it is created. Calling it anyway would log
   * "Attached …" for a join that never happened.
   */
  private async skipsNetworkHotAttach(gap: string, consequence: string): Promise<boolean> {
    if (!(await this.isAppleContainerEngine())) {
      return false;
    }
    if (!this.warnedAppleContainerGaps.has(gap)) {
      this.warnedAppleContainerGaps.add(gap);
      this.logger.warn(`${gap}: Apple container cannot attach or detach a running container's networks. ${consequence}`);
    }
    return true;
  }

  /**
   * Re-joins app networks after the Hub container is recreated.
   *
   * An update that replaces this container drops every network connected in place. Running apps are
   * not composed again, so without this their off-network services go back to `ENOTFOUND ci-hub`
   * until the next `up`.
   */
  public async ensureHubOnAppNetworks(): Promise<void> {
    if (await this.skipsNetworkHotAttach(HUB_APP_NETWORK_GAP, HUB_APP_NETWORK_CONSEQUENCE)) {
      return;
    }
    if (!(await this.runningHubContainerName())) {
      return;
    }
    const [current, legacy] = await Promise.all([
      this.listNetworksSafe({ filters: { label: [`${HUB_MANAGED_LABEL}=true`] } }),
      this.listNetworksSafe({ filters: { label: [`${LEGACY_HUB_MANAGED_LABEL}=true`] } }),
    ]);
    const byId = new Map<string, AppProjectNetwork>();
    for (const network of [...current, ...legacy]) {
      if (network.Id) {
        byId.set(network.Id, network);
      }
    }
    await this.joinHubToAppNetworks([...byId.values()]);
  }

  /**
   * Leaves an app's networks before `down` or before the Hub deletes them.
   *
   * Compose treats an extra container on the network as "still in use" and keeps the network.
   * Infrastructure networks (the shared Hub network, the edge network) are never disconnected:
   * the Hub belongs there. A network this method did not join is also left, including external
   * networks a user compose file brought in.
   *
   * Never throws.
   */
  public async detachHubFromAppNetworks(appUrn: AppUrn): Promise<void> {
    // The Hub never joined these networks on Apple container, so it has nothing to leave. No
    // warning: attach already said so once, and an uninstall is not the moment to repeat it.
    if (await this.isAppleContainerEngine()) {
      return;
    }
    const hubName = await this.runningHubContainerName();
    if (!hubName) {
      return;
    }

    const attached = await this.hubNetworkNames(hubName);
    if (!attached) {
      return;
    }

    for (const network of await this.listComposeProjectNetworks(appUrn)) {
      const id = network.Id;
      const name = network.Name;
      if (!id || !name || this.isInfrastructureNetwork(name) || !attached.has(name)) {
        continue;
      }
      if (network.Labels?.['com.docker.compose.network.external'] === 'true') {
        continue;
      }

      try {
        await this.docker.getNetwork(id).disconnect({ Container: hubName, Force: true });
        this.logger.info(`Detached ${hubName} from ${name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not connected/i.test(message)) {
          continue;
        }
        this.logger.warn(
          `Could not detach ${hubName} from ${name}: ${message}. The app network may survive compose down while this container is still on it.`,
        );
      }
    }
  }

  private async joinHubToAppNetworks(networks: AppProjectNetwork[]): Promise<void> {
    const hubName = await this.runningHubContainerName();
    if (!hubName) {
      this.logger.debug('Hub container is not running; not joining app networks');
      return;
    }

    const attached = await this.hubNetworkNames(hubName);
    if (!attached) {
      return;
    }

    for (const network of networks) {
      const id = network.Id;
      const name = network.Name;
      if (!id || !name || this.isInfrastructureNetwork(name) || attached.has(name)) {
        continue;
      }
      if (network.Labels?.['com.docker.compose.network.external'] === 'true') {
        continue;
      }

      let internal = false;
      try {
        const inspected = await this.docker.getNetwork(id).inspect();
        internal = inspected?.Internal === true;
      } catch (error) {
        this.logger.warn(`Could not inspect ${name} before joining it: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (internal) {
        this.logger.info(`Not joining ${name}: it is an internal network, so containers on it stay cut off from the Hub`);
        continue;
      }

      try {
        // `GwPriority` is newer than the dockerode typings (Engine API 1.48). Both names are
        // registered because a legacy compose file still runs this process as `ci-os-hub` while
        // apps look up `ci-hub`, and the other way around after the rename.
        const endpoint = { Aliases: [DEFAULT_HUB_CONTAINER_NAME, LEGACY_HUB_CONTAINER_NAME], GwPriority: -1 };
        await this.docker.getNetwork(id).connect({ Container: hubName, EndpointConfig: endpoint } as never);
        attached.add(name);
        this.logger.info(`Attached ${hubName} to ${name} so app containers can resolve ${DEFAULT_HUB_CONTAINER_NAME}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/already exists/i.test(message)) {
          continue;
        }
        this.logger.warn(
          `Could not attach ${hubName} to ${name}: ${message}. ` +
            `Services that are not on the shared Hub network cannot resolve ${DEFAULT_HUB_CONTAINER_NAME} until this succeeds.`,
        );
      }
    }
  }

  private isInfrastructureNetwork(name: string): boolean {
    return (HUB_NETWORK_NAMES as readonly string[]).includes(name) || name === HUB_EDGE_NETWORK_NAME;
  }

  private async listComposeProjectNetworks(appUrn: AppUrn): Promise<AppProjectNetwork[]> {
    const projectName = this.getComposeProjectName(appUrn);
    return this.listNetworksSafe({ filters: { label: [`com.docker.compose.project=${projectName}`] } });
  }

  private async listNetworksSafe(options: Parameters<Dockerode['listNetworks']>[0]): Promise<AppProjectNetwork[]> {
    try {
      const listed = await this.docker.listNetworks(options);
      return Array.isArray(listed) ? listed : [];
    } catch (error) {
      this.logger.warn(`Failed to list Docker networks: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** The names of the networks this container is on, or null when it cannot be inspected. */
  private async hubNetworkNames(hubName: string): Promise<Set<string> | null> {
    try {
      const info = await this.docker.getContainer(hubName).inspect();
      return new Set(Object.keys(info?.NetworkSettings?.Networks ?? {}));
    } catch (error) {
      this.logger.warn(`Could not inspect ${hubName} to see which app networks it is on: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * The running Hub container, under whichever name this process was started with.
   *
   * An image-only update can still be `ci-os-hub`. Apps are given the same name `hubContainerName`
   * returns, and the connect call also registers the other name as an alias.
   */
  private async runningHubContainerName(): Promise<string | null> {
    const names = [...new Set([hubContainerName(), ...HUB_CONTAINER_NAMES])];
    for (const name of names) {
      try {
        const info = await this.docker.getContainer(name).inspect();
        if (info?.State?.Running) {
          return (info.Name ?? `/${name}`).replace(/^\//, '');
        }
      } catch {
        // The other historical name may be the one that is running.
      }
    }
    return null;
  }

  /**
   * Puts a running Traefik on the edge network, at its fixed address, when it is not there yet.
   *
   * cloudflared is on the edge network ONLY, so the tunnel's `traefik:80` resolves only while
   * Traefik is there too. The two are created together by a full `up`, but not always: a Hub rolled
   * with `up -d ci-hub` against the new compose file keeps the Traefik created before the edge
   * network existed, and when this Hub then recreates cloudflared (a re-pair, a recovered token, a
   * crash-looping tunnel at boot) compose creates the network for cloudflared alone, and every app
   * hostname returns 502 until someone runs a full `up`.
   *
   * Connected in place rather than recreated: recreating Traefik from inside the Hub would take the
   * Hub's compose and env file (see `ensureCloudflaredRunning` on the config hashes they disagree
   * on), not the host's `.env.dev`, which alone holds the fleet's HTTPS_PORT. `GwPriority: -1` keeps
   * its default route where it was: a network connected to a running container otherwise takes it
   * over when it sorts first (Docker 29.8), and Traefik's own connections to the host would then
   * leave from the edge subnet, outside what fleet firewalls admit from Docker bridges.
   *
   * Does nothing when the edge network does not exist (a compose file from before it, where
   * cloudflared shares the Hub network with Traefik) or Traefik is not running. Never throws: a
   * failure is logged with the command that fixes it.
   */
  public async ensureTraefikOnEdgeNetwork(): Promise<'attached' | 'present' | 'skipped' | 'failed'> {
    let traefikNetworks: Record<string, unknown>;
    try {
      await this.docker.getNetwork(HUB_EDGE_NETWORK_NAME).inspect();
      const traefik = await this.docker.getContainer(TRAEFIK_CONTAINER_NAME).inspect();
      if (!traefik?.State?.Running) {
        return 'skipped';
      }
      traefikNetworks = traefik.NetworkSettings?.Networks ?? {};
    } catch {
      return 'skipped';
    }

    if (traefikNetworks[HUB_EDGE_NETWORK_NAME]) {
      return 'present';
    }

    // A Traefik created with the edge network by a full `up` is 'present' above. One that predates
    // it cannot be joined in place here, so say what recreates it rather than log a join that did not happen.
    if (
      await this.skipsNetworkHotAttach(
        `Not attaching ${TRAEFIK_CONTAINER_NAME} to ${HUB_EDGE_NETWORK_NAME}`,
        'Tunnelled app hostnames cannot reach Traefik until it is recreated from the current compose file ' +
          "(`cihub up`, or `docker compose up -d traefik` with the stack's env file).",
      )
    ) {
      return 'failed';
    }

    const address = resolveEdgeHopAddress(process.env.HUB_EDGE_TRAEFIK_IP, DEFAULT_HUB_EDGE_TRAEFIK_IP);
    try {
      // `GwPriority` is newer than the dockerode typings (Engine API 1.48).
      const endpoint = { IPAMConfig: { IPv4Address: address }, Aliases: [TRAEFIK_CONTAINER_NAME], GwPriority: -1 };
      await this.docker.getNetwork(HUB_EDGE_NETWORK_NAME).connect({ Container: TRAEFIK_CONTAINER_NAME, EndpointConfig: endpoint } as never);
      this.logger.info(`Attached ${TRAEFIK_CONTAINER_NAME} to ${HUB_EDGE_NETWORK_NAME} at ${address}, where cloudflared reaches it`);
      return 'attached';
    } catch (error) {
      this.logger.warn(
        `Could not attach ${TRAEFIK_CONTAINER_NAME} to ${HUB_EDGE_NETWORK_NAME} at ${address}: ${error instanceof Error ? error.message : String(error)}. ` +
          'Tunnelled app hostnames cannot reach Traefik until it is recreated from the current compose file ' +
          "(`cihub up`, or `docker compose up -d traefik` with the stack's env file).",
      );
      return 'failed';
    }
  }

  /**
   * Stops and removes a container, treating one that does not exist as removed.
   *
   * Returns false when Docker could not remove it, so a caller that needs the container gone can
   * try again later. Never throws.
   */
  public async removeContainer(containerName: string): Promise<boolean> {
    try {
      await this.runProcessBounded('docker', ['rm', '-f', containerName], {}, 30_000, `docker rm -f ${containerName}`);
      this.logger.info(`Removed container ${containerName}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Older Docker CLIs exit non-zero from `rm -f` when there is nothing to remove.
      if (/no such container/i.test(message)) {
        return true;
      }
      this.logger.warn(`Could not remove container ${containerName}: ${message}`);
      return false;
    }
  }

  /**
   * Spawns a process and rejects if it exceeds `timeoutMs`.
   *
   * On timeout, send SIGTERM and then SIGKILL after a grace period so a stalled
   * `docker` or `docker compose` process cannot block its caller indefinitely.
   *
   * Normally, wait for the child's `close` event before rejecting so a retry does
   * not overlap a process that is still shutting down. A hard backstop unblocks
   * the caller if the child never exits. In that rare case, Docker serializes
   * overlapping daemon work by image or container name.
   *
   * Like `runDockerCompose`, this method kills only the Docker CLI, not its
   * process group. Pull and create work can continue in `dockerd`, where the
   * daemon deduplicates it and lets a retry attach safely.
   */
  private runProcessBounded(
    command: string,
    commandArgs: string[],
    spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv },
    timeoutMs: number,
    label: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Drain both default pipe streams so a verbose child cannot block on a full
      // buffer until the timeout.
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

      // A `data` listener puts stdout in flowing mode. Capture stderr while also
      // draining it so neither pipe can stall the child.
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
          // Honor a clean exit even if the timeout just sent SIGTERM. The process
          // completed successfully, so reporting a timeout would cause an
          // unnecessary retry.
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

  /** Runs `fn` at least once and rejects with the final error after all attempts. */
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

  /**
   * Runs `<command> <args>` to completion and reports whether it exited 0, with the first line
   * of stderr (or the spawn error) as the reason when it did not.
   */
  private probeCommand(command: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      const probe = spawn(command, args, { stdio: 'pipe' });
      let stderr = '';
      probe.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      probe.on('close', (code) => {
        const firstLine = stderr.trim().split('\n')[0]?.trim();
        resolve({ ok: code === 0, detail: firstLine || `exit ${code}` });
      });
      probe.on('error', (err) => resolve({ ok: false, detail: err.message }));
    });
  }

  /**
   * Picks the compose CLI for a Hub stack service the same way {@link composeApp} does for apps:
   * the `docker compose` plugin when it answers, otherwise the standalone `docker-compose` binary.
   *
   * The fallback is what kept apps working while cloudflared did not. The Hub image links its
   * bundled binary into `$DOCKER_CONFIG/cli-plugins` at start, and `ln` cannot create that
   * directory. On beta-ms-a2, beta-red, and beta-max (2026-09-17) `/data/.docker` existed without
   * `cli-plugins`, so `docker compose version` failed while `/usr/local/bin/docker-compose` was
   * present. Apps went through the fallback; this path hard-coded `docker compose` and failed
   * with "unknown flag: --env-file".
   */
  private async resolveComposeCli(serviceName: string): Promise<{ command: string; prefix: string[] }> {
    try {
      await this.assertComposePluginAvailable();
      return { command: 'docker', prefix: ['compose'] };
    } catch (pluginError) {
      const standalone = await this.probeCommand('docker-compose', ['version']);
      if (standalone.ok) {
        this.logger.warn(`docker compose plugin not available; using the docker-compose binary for ${serviceName}`);
        return { command: 'docker-compose', prefix: [] };
      }
      // Probed again only to put the plugin's own error text in the message.
      const plugin = await this.probeCommand('docker', ['compose', 'version']);
      throw new ComposeCliUnavailableError(
        describeComposeCliUnavailable({
          service: serviceName,
          pluginDetail: plugin.ok ? (pluginError instanceof Error ? pluginError.message : String(pluginError)) : plugin.detail,
          standaloneDetail: standalone.detail,
        }),
      );
    }
  }

  private async composeUpService(serviceName: string, opts: { composeFile: string; profile?: string; forceRecreate?: boolean }): Promise<void> {
    const { command, prefix } = await this.resolveComposeCli(serviceName);
    const baseArgs = [...prefix];
    const runtimeComposeFile = path.join(this.config.get('directories').dataDir, 'docker-compose.yml');
    const spawnOptions: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: path.dirname(opts.composeFile) };

    if (opts.composeFile === runtimeComposeFile) {
      const envFilePath = this.config.get('envFilePath');
      baseArgs.push('--env-file', envFilePath);
      // Match the project name used by `start.ts` and package scripts so Compose
      // attaches to the running stack instead of creating another stack.
      const composeProjectName = process.env.CI_HUB_COMPOSE_PROJECT_NAME || 'ci-hub';
      baseArgs.push('--project-name', composeProjectName);

      // Inside the Hub container, Compose resolves relative bindings such as
      // `./tunnel` against `/data`. The host daemon would then interpret `/data`
      // on the host, not the Hub data directory. Set the host project directory
      // so bindings resolve below `ROOT_FOLDER_HOST`.
      const hostProjectDir = process.env.ROOT_FOLDER_HOST?.trim();
      if (hostProjectDir) {
        baseArgs.push('--project-directory', hostProjectDir);
      }

      // Use only the filename in `ENV_FILE` so Compose resolves `env_file`
      // correctly inside the container.
      spawnOptions.env = { ...process.env, ENV_FILE: path.basename(envFilePath) };
    }

    baseArgs.push('-f', opts.composeFile);

    if (opts.profile) {
      baseArgs.push('--profile', opts.profile);
    }

    // Bound and retry service startup. Compose `pull_policy` downloads only an
    // image that is not already present, so cached images need no registry request
    // while cold pulls run within `COMPOSE_UP_TIMEOUT_MS`. Kill and retry a
    // stalled operation; completed image layers remain available across attempts.
    const upArgs = [...baseArgs, 'up', serviceName, '-d', '--no-build', '--no-deps'];
    if (opts.forceRecreate) {
      upArgs.push('--force-recreate');
    }
    const cli = [command, ...prefix].join(' ');
    this.logger.info(`Running: ${command} ${upArgs.join(' ')}`);
    await this.retryAsync(
      () => this.runProcessBounded(command, upArgs, spawnOptions, COMPOSE_UP_TIMEOUT_MS, `${cli} up ${serviceName}`),
      COMPOSE_OP_MAX_ATTEMPTS,
      `up ${serviceName}`,
    );
    this.logger.info(`Service ${serviceName} is up via ${cli}`);
  }

  /**
   * Polls after `compose up` until labeled containers reach a stable running
   * state, or returns the final failed verification.
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

  /**
   * Creates a pre-update snapshot of the app's volumes and data directory before an update begins.
   *
   * Discovers the app's host data directory, project containers, and Docker named volumes,
   * creating a snapshot copy of the host data directory and cataloging all volumes.
   *
   * @param appUrn App URN to snapshot.
   * @returns Snapshot result including snapshotted paths and volumes.
   */
  public async createPreUpdateVolumeSnapshot(appUrn: AppUrn, options: { includeData?: boolean } = {}): Promise<PreUpdateVolumeSnapshotResult> {
    const includeData = options.includeData ?? true;
    const projectName = this.getComposeProjectName(appUrn);
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const timestamp = new Date().toISOString();
    const snapshotId = `pre-update-${appName}-${Date.now()}`;
    let snapshotBaseDir: string | undefined;

    try {
      const { appDataDir, appInstalledDir } = this.appFilesManager.getAppPaths(appUrn);
      const { dataDir } = this.config.get('directories');
      snapshotBaseDir = path.join(dataDir, 'snapshots', appStoreId, appName, snapshotId);

      const snapshottedVolumes: PreUpdateVolumeSnapshotResult['volumes'] = [];

      // The data folder is by far the largest part. A caller that has just taken a backup already has
      // it in a restorable form and asks for the installed files only.
      const appDataExists = includeData && (await this.filesystem.pathExists(appDataDir));
      let snapshotPath: string | undefined;

      if (appDataExists) {
        snapshotPath = path.join(snapshotBaseDir, 'app-data');
        this.logger.info(`[pre-update-snapshot] Snapshotting ${appDataDir} to ${snapshotPath}`);
        await this.filesystem.createDirectory(snapshotPath);
        // `copyDirectory` reports a full disk or a permission error by returning false. A snapshot
        // that is only part of the data and says it is whole would later be restored over the real thing.
        if ((await this.filesystem.copyDirectory(appDataDir, snapshotPath)) === false) {
          throw new Error(`Could not copy ${appDataDir} into the snapshot`);
        }
        snapshottedVolumes.push({
          type: 'bind',
          source: appDataDir,
          snapshotTarget: snapshotPath,
        });
      }

      // Also snapshot the installed app files (docker-compose.yml, config.json) — the update
      // is about to delete and replace this whole directory with the new version's files, and
      // without this, a rollback can only restore data, never the previous compose/version.
      const appFilesExist = await this.filesystem.pathExists(appInstalledDir);
      let appFilesSnapshotPath: string | undefined;

      if (appFilesExist) {
        appFilesSnapshotPath = path.join(snapshotBaseDir, 'app-files');
        this.logger.info(`[pre-update-snapshot] Snapshotting ${appInstalledDir} to ${appFilesSnapshotPath}`);
        await this.filesystem.createDirectory(appFilesSnapshotPath);
        if ((await this.filesystem.copyDirectory(appInstalledDir, appFilesSnapshotPath)) === false) {
          throw new Error(`Could not copy ${appInstalledDir} into the snapshot`);
        }
      }

      const containers = await this.docker
        .listContainers({
          all: true,
          filters: { label: [`com.docker.compose.project=${projectName}`] },
        })
        .catch((err) => {
          this.logger.warn(`Failed to list containers for ${appUrn} snapshot: ${err}`);
          return [];
        });

      const volumeList = await this.docker
        .listVolumes({
          filters: { label: [`com.docker.compose.project=${projectName}`] },
        })
        .catch((err) => {
          this.logger.warn(`Failed to list docker volumes for ${appUrn} snapshot: ${err}`);
          return { Volumes: [] };
        });

      for (const vol of volumeList.Volumes ?? []) {
        if (!snapshottedVolumes.some((v) => v.name === vol.Name)) {
          snapshottedVolumes.push({
            name: vol.Name,
            type: 'volume',
            source: vol.Mountpoint || vol.Name,
          });
        }
      }

      for (const container of containers) {
        for (const mount of container.Mounts ?? []) {
          if (!snapshottedVolumes.some((v) => v.source === mount.Source || (mount.Name && v.name === mount.Name))) {
            snapshottedVolumes.push({
              name: mount.Name,
              type: mount.Type === 'volume' ? 'volume' : 'bind',
              source: mount.Source,
              destination: mount.Destination,
            });
          }
        }
      }

      this.logger.info(`[pre-update-snapshot] Created volume snapshot ${snapshotId} for ${appUrn} (${snapshottedVolumes.length} volumes recorded)`);

      return {
        appUrn,
        snapshotId,
        timestamp,
        snapshotBaseDir,
        snapshotPath,
        appFilesSnapshotPath,
        volumes: snapshottedVolumes,
        success: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[pre-update-snapshot] Failed to create volume snapshot for ${appUrn}: ${message}`);

      // Whatever was written is not a snapshot, only disk space.
      if (snapshotBaseDir) {
        await this.filesystem.removeDirectory(snapshotBaseDir).catch(() => undefined);
      }

      return {
        appUrn,
        snapshotId,
        timestamp,
        volumes: [],
        success: false,
        error: message,
      };
    }
  }

  /**
   * Verifies health probe status for all containers in an app's Compose project.
   *
   * Containers with a health check defined in Docker/Compose must be in 'healthy' status.
   * Containers without a health check must be in a 'running' status.
   *
   * @param appUrn App URN.
   * @param options Optional retry options (maxAttempts, delayMs).
   */
  public async verifyContainerHealthProbe(appUrn: AppUrn, options?: { maxAttempts?: number; delayMs?: number }): Promise<ContainerHealthProbeResult> {
    const projectName = this.getComposeProjectName(appUrn);
    const maxAttempts = options?.maxAttempts ?? 1;
    const delayMs = options?.delayMs ?? 1000;

    let lastResult: ContainerHealthProbeResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let containers = await this.docker
        .listContainers({
          all: true,
          filters: { label: [`com.docker.compose.project=${projectName}`] },
        })
        .catch((err) => {
          this.logger.warn(`Failed to list containers for health probe ${appUrn}: ${err}`);
          return [];
        });

      if (containers.length === 0) {
        containers = await listContainersMatchingAnyLabelSets(this.docker, managedAppLabelSets(appUrn)).catch(() => []);
      }

      if (containers.length === 0) {
        lastResult = {
          ok: false,
          healthy: false,
          containers: [],
          message: `No containers found for app ${appUrn}`,
        };
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        return lastResult;
      }

      const containerDetails: ContainerHealthProbeDetail[] = [];

      for (const container of containers) {
        const dockerContainer = this.docker.getContainer(container.Id);
        let inspect: Dockerode.ContainerInspectInfo | undefined;
        try {
          inspect = await dockerContainer.inspect();
        } catch (inspectErr) {
          this.logger.warn(`Failed to inspect container ${container.Id} for health probe: ${inspectErr}`);
        }

        const name = container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12);
        const state = inspect?.State?.Status || container.State || 'unknown';
        const health = inspect?.State?.Health;
        const hasHealthCheck = Boolean(health);
        const healthStatus = health?.Status ?? null;
        const failingStreak = health?.FailingStreak;
        const log = health?.Log?.map((entry) => entry.Output || '').filter(Boolean);
        const status = container.Status || state;
        const exitCode = inspect?.State?.Running ? null : (inspect?.State?.ExitCode ?? (/Exited \(0\)/.test(status) ? 0 : null));

        containerDetails.push({
          id: container.Id,
          name,
          status,
          state,
          healthStatus,
          hasHealthCheck,
          exitCode,
          failingStreak,
          log,
        });
      }

      // A container without a health check must be running UNLESS it exited cleanly (code 0) —
      // that's a completed one-shot init job (migrate-database, setup-secrets, fix-db-permissions,
      // etc.), not a crashed long-running service. Mirrors the running+exitZero convention that
      // app-status-sync.service.ts / managed-app-containers.ts already use to decide app status.
      const unhealthyContainers = containerDetails.filter((c) => {
        if (c.hasHealthCheck) {
          return c.healthStatus !== 'healthy';
        }
        if (c.state === 'running') {
          return false;
        }
        return !(c.state === 'exited' && c.exitCode === 0);
      });

      const allHealthy = unhealthyContainers.length === 0;

      lastResult = {
        ok: allHealthy,
        healthy: allHealthy,
        containers: containerDetails,
        message: allHealthy
          ? `All containers for ${appUrn} passed health probes`
          : `Health probe failed for ${appUrn}: ${unhealthyContainers.map((c) => `${c.name} (${c.healthStatus || c.state})`).join(', ')}`,
      };

      if (allHealthy || attempt >= maxAttempts) {
        return lastResult;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return (
      lastResult ?? {
        ok: false,
        healthy: false,
        containers: [],
        message: `Health probe timed out for ${appUrn}`,
      }
    );
  }
}
