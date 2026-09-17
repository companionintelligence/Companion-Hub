import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import axios from 'axios';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { DATA_DIR, HUB_STACK_IMAGE_REPO, HUB_STACK_REGISTRY_REPO, UPDATE_LISTENER_TOKEN_FILENAME, hubContainerName } from '@/common/constants';
import { writeSettingsJsonFile } from '@/common/helpers/env-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { RegistryService } from '@/utils/registry/registry.service';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';
import {
  channelUpdateRefusal,
  type ComposeUpdatePlan,
  type DockerContainerInspect,
  type DockerImageInspect,
  describeRunningBuild,
  HUB_VERSION_TAG_MESSAGE,
  isHubVersionTag,
  readEnvFileValue,
  resolveComposeUpdatePlan,
  resolveRunningHubBuild,
  type RunningHubBuild,
  selectReleaseTarget,
} from './hub-deployment';
import { buildStackUpdaterRunArgs, buildStackUpdaterScript, ENV_RESTORE_VARIABLE, stackUpdaterContainerName } from './stack-updater';

export const HOST_LISTENER_PORT = 17400;
const HOST_LISTENER_PROBE_TIMEOUT_MS = 1500;
const HOST_LISTENER_TRIGGER_TIMEOUT_MS = 10_000;

export type StackUpdateState = 'updating' | 'skipped' | 'failed';
export type HostUpdateState = 'started' | 'unavailable' | 'failed';

export type PerformUpdateResult = {
  success: boolean;
  message: string;
  stack: StackUpdateState;
  host: HostUpdateState;
};

/** Hub container probe — `/.dockerenv` plus Podman's containerenv. Not the `/data` heuristic. */
export function detectHubContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  } catch {
    return false;
  }
}

/** From inside Docker, the desktop listener is on the host — not this container's loopback. */
export function resolveHostListenerBaseUrl(inContainer: boolean = detectHubContainer()): string {
  const host = inContainer ? 'host.docker.internal' : '127.0.0.1';
  return `http://${host}:${HOST_LISTENER_PORT}`;
}

/** GHCR tags are unprefixed (`0.2.56`). A leading `v` makes the pull 404. */
function normalizeHubVersionTag(version: string): string {
  const tag = version.trim();
  if (!isHubVersionTag(tag)) {
    throw new BadRequestException(HUB_VERSION_TAG_MESSAGE);
  }
  return tag.replace(/^v/i, '');
}

/**
 * Where to look for this Hub's own container. The hostname is the container ID unless compose sets
 * `hostname:`, which makes it the one lookup that cannot find a different container; the names cover
 * the rest, legacy topology included.
 */
function selfContainerCandidates(): string[] {
  return [...new Set([os.hostname(), hubContainerName(), 'ci-hub', 'ci-os-hub'].filter(Boolean))];
}

const NOT_IN_CONTAINER_MESSAGE =
  'This Hub is not running in a container, so there is no Hub image for the self-updater to replace. Update the checkout or the process that runs it instead.';

/** Seconds the helper waits before compose stops the Hub, so the HTTP response that started it can leave. */
const HELPER_START_DELAY_SECONDS = 3;

type RunningHub = { container: DockerContainerInspect; image: DockerImageInspect | null; build: RunningHubBuild };

export type UpdateCheckResult = {
  current: string;
  latest: string;
  releases: { version: string; body: string }[];
  updateAvailable: boolean;
  /** The image, release and commit this Hub is running, read from Docker. Null when it could not be read. */
  build: { reference: string; version: string | null; revision: string | null; channel: RunningHubBuild['channel']['kind'] } | null;
  /** Why this node will not be updated by the Hub, even when a newer release exists. */
  updateBlockedReason: string | null;
};

@Injectable()
export class SystemUpdateService implements OnApplicationBootstrap, OnApplicationShutdown {
  autoUpdateInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly registryService: RegistryService,
    @Optional() private readonly agentNotifyService?: AgentNotifyService,
  ) {}

  onApplicationBootstrap() {
    const { __prod__ } = this.config.getConfig();
    if (__prod__) {
      this.logger.info('Scheduling daily auto-update check');
      this.autoUpdateInterval = setInterval(() => this.autoUpdateCheck(), SystemUpdateService.CHECK_INTERVAL_MS);
    }
  }

  onApplicationShutdown() {
    if (this.autoUpdateInterval) {
      clearInterval(this.autoUpdateInterval);
      this.autoUpdateInterval = null;
    }
  }

  /**
   * What this Hub runs and whether the self-updater may move it. `current` comes from the running
   * image, never from `CI_HUB_VERSION` — see hub-deployment.ts for how wrong that value was.
   */
  async checkForUpdates(): Promise<UpdateCheckResult> {
    let running: RunningHub;
    try {
      running = await this.inspectRunningHub();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { current: 'unknown', latest: 'unknown', releases: [], updateAvailable: false, build: null, updateBlockedReason: reason };
    }

    const { build } = running;
    const current = describeRunningBuild(build);
    let updateBlockedReason = channelUpdateRefusal(build, this.readDeclaredHubImage());
    // performUpdate refuses a stack it cannot reproduce unless the desktop listener takes the update.
    // Without this the daily timer and Settings would offer it on core-3 and beta-3-glass (compose read
    // `.env`, the Hub mounts `.env.dev`) and every attempt would end in a 409.
    if (updateBlockedReason === null) {
      const plan = resolveComposeUpdatePlan(running.container, this.composeMountTargets());
      if (!plan.ok && !(await this.probeHostListener())) {
        updateBlockedReason = plan.reason;
      }
    }
    const tags = build.version ? await this.registryService.getTagsSinceWithHubFallback(HUB_STACK_REGISTRY_REPO, build.version) : [];
    const releases = tags.map((tag) => ({ version: tag, body: `Release ${tag}` }));
    const target = build.version ? selectReleaseTarget(build.version, tags) : null;
    const updateAvailable = target !== null && updateBlockedReason === null;

    if (updateAvailable) {
      this.agentNotifyService?.notify('system.update_available', { current, latest: target }, 'low');
    }

    return {
      current,
      latest: target ?? current,
      releases,
      updateAvailable,
      build: { reference: build.reference, version: build.version, revision: build.revision, channel: build.channel.kind },
      updateBlockedReason,
    };
  }

  /** `CI_HUB_IMAGE` as the operator declared it: the env file first, then what this container was created with. */
  private readDeclaredHubImage(): string | null {
    const content = this.readEnvFile(this.hubEnvFilePath());
    return (content === null ? null : readEnvFileValue(content, 'CI_HUB_IMAGE')) ?? process.env.CI_HUB_IMAGE ?? null;
  }

  private hubEnvFilePath(): string {
    return path.join(this.config.get('directories').dataDir, '.env');
  }

  /** Where the Hub container sees the env file and compose file the updater reads and pins. */
  private composeMountTargets(): { envFile: string; composeFile: string } {
    const { dataDir } = this.config.get('directories');
    return { envFile: path.join(dataDir, '.env'), composeFile: path.join(dataDir, 'docker-compose.yml') };
  }

  private readEnvFile(envFile: string): string | null {
    try {
      return fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : null;
    } catch {
      return null;
    }
  }

  private upsertEnvLine(lines: string[], key: string, value: string): string[] {
    // A line break would add a line of its own to the Hub .env, which the desktop reads at launch.
    if (/[\r\n]/.test(value)) {
      throw new Error(`Refusing to write ${key} to the Hub .env: the value contains a line break`);
    }
    const line = `${key}=${value}`;
    let replaced = false;
    const next = lines.map((entry) => {
      if (entry.startsWith(`${key}=`)) {
        replaced = true;
        return line;
      }
      return entry;
    });
    if (!replaced) {
      next.push(line);
    }
    return next;
  }

  /**
   * Pin the stack image + reported Hub version so UI and compose agree after restart. Returns the
   * content it replaced, so a failed update can put it back; undefined when there was no file.
   */
  private pinHubStackVersionInEnv(envFile: string, targetVersion: string): string | undefined {
    if (!fs.existsSync(envFile)) {
      return undefined;
    }

    const imageLine = `${HUB_STACK_IMAGE_REPO}:${targetVersion}`;
    const content = fs.readFileSync(envFile, 'utf8');
    let lines = content.split('\n');
    lines = this.upsertEnvLine(lines, 'CI_HUB_IMAGE', imageLine);
    lines = this.upsertEnvLine(lines, 'CI_HUB_VERSION', targetVersion);
    fs.writeFileSync(envFile, lines.join('\n'));
    this.logger.info(`Pinned stack update in ${envFile}: CI_HUB_IMAGE=${imageLine}, CI_HUB_VERSION=${targetVersion}`);
    return content;
  }

  private restoreEnvFile(envFile: string, previous: string | undefined): void {
    if (previous === undefined) return;
    try {
      fs.writeFileSync(envFile, previous);
      this.logger.info(`Restored the previous Hub stack pin in ${envFile}`);
    } catch (error) {
      this.logger.error(`Could not restore ${envFile} after a failed update; check CI_HUB_IMAGE by hand`, error);
    }
  }

  private stackUpdateLogPath(dataDir: string): string {
    const logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    return path.join(logsDir, 'hub-stack-update.log');
  }

  async getHostListenerStatus(): Promise<{ reachable: boolean }> {
    return { reachable: await this.probeHostListener() };
  }

  async probeHostListener(): Promise<boolean> {
    const token = this.getHostUpdateListenerToken();
    if (!token) {
      return false;
    }

    try {
      const response = await axios.get(`${resolveHostListenerBaseUrl()}/health`, {
        timeout: HOST_LISTENER_PROBE_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async triggerHostListener(): Promise<Exclude<HostUpdateState, 'unavailable'>> {
    const token = this.getHostUpdateListenerToken();
    if (!token) {
      return 'failed';
    }

    try {
      const response = await axios.post(`${resolveHostListenerBaseUrl()}/update`, null, {
        timeout: HOST_LISTENER_TRIGGER_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });
      return response.status >= 200 && response.status < 300 ? 'started' : 'failed';
    } catch {
      return 'failed';
    }
  }

  /**
   * Move this Hub to another release.
   *
   * Every refusal happens before the env file is written or an image is pulled: a node that is not on
   * a release pin (ConflictException), a stack this container cannot reproduce (ConflictException),
   * and a malformed target (BadRequestException). A helper that cannot start puts the old pin back.
   */
  async performUpdate(targetVersion?: string): Promise<PerformUpdateResult> {
    const requested = targetVersion === undefined ? undefined : normalizeHubVersionTag(targetVersion);

    const running = await this.inspectRunningHub();
    const refusal = channelUpdateRefusal(running.build, this.readDeclaredHubImage());
    if (refusal) {
      this.logger.warn(`Hub stack update refused: ${refusal}`);
      throw new ConflictException(refusal);
    }

    const pinned = requested ?? (await this.latestReleaseFor(running.build));
    const imageRef = `${HUB_STACK_IMAGE_REPO}:${pinned}`;
    this.logger.info(`Hub stack update initiated from ${running.build.reference} to ${imageRef}`);

    const { dataDir } = this.config.get('directories');
    const mountTargets = this.composeMountTargets();
    const envFile = mountTargets.envFile;
    const planResult = resolveComposeUpdatePlan(running.container, mountTargets);

    const listenerReachable = await this.probeHostListener();
    if (listenerReachable) {
      const previous = this.pinHubStackVersionInEnv(envFile, pinned);
      const host = await this.triggerHostListener();
      if (host === 'started') {
        this.logger.info('Host update listener accepted the update; desktop will stop the stack and pull on relaunch');
        return {
          success: true,
          message: 'Update initiated, hub will restart shortly',
          stack: 'skipped',
          host: 'started',
        };
      }
      this.logger.warn('Host update listener trigger failed; falling back to stack-only update');
      // The stack path pins again once it knows it can proceed.
      this.restoreEnvFile(envFile, previous);
    }

    if (!planResult.ok) {
      this.logger.warn(`Hub stack update refused: ${planResult.reason}`);
      throw new ConflictException(planResult.reason);
    }

    await this.pullAndRecreateHubStack(planResult.plan, imageRef, pinned, envFile, dataDir);
    return {
      success: true,
      message: 'Update initiated, hub will restart shortly',
      stack: 'updating',
      host: listenerReachable ? 'failed' : 'unavailable',
    };
  }

  /** The newest release above the running one, or the running release itself when none is newer. */
  private async latestReleaseFor(build: RunningHubBuild): Promise<string> {
    if (!build.version) {
      // channelUpdateRefusal already refused every build without a version pin; this is the type guard.
      throw new ConflictException('The running Hub release is unknown, so there is no release to update from.');
    }
    const tags = await this.registryService.getTagsSinceWithHubFallback(HUB_STACK_REGISTRY_REPO, build.version);
    return selectReleaseTarget(build.version, tags) ?? build.version;
  }

  /**
   * Read this Hub's own container and image. Refuses outside a container, and when Docker cannot
   * answer, rather than guess: guessing is what `CI_HUB_VERSION` and the fixed layout were.
   */
  private async inspectRunningHub(): Promise<RunningHub> {
    if (!detectHubContainer()) {
      throw new ConflictException(NOT_IN_CONTAINER_MESSAGE);
    }
    for (const candidate of selfContainerCandidates()) {
      let container: DockerContainerInspect | undefined;
      try {
        container = (JSON.parse(await this.runDockerCapture(['inspect', '--type', 'container', candidate])) as DockerContainerInspect[])[0];
      } catch {
        continue;
      }
      if (!container) continue;
      let image: DockerImageInspect | null = null;
      if (container.Image) {
        try {
          image = (JSON.parse(await this.runDockerCapture(['image', 'inspect', container.Image])) as DockerImageInspect[])[0] ?? null;
        } catch {
          // RepoTags only add a version source; the reference and labels still stand.
        }
      }
      return { container, image, build: resolveRunningHubBuild(container, image) };
    }
    throw new ConflictException('The Hub could not inspect its own container through the Docker socket, so it cannot tell which image it runs.');
  }

  private async pullAndRecreateHubStack(plan: ComposeUpdatePlan, imageRef: string, version: string, envFile: string, dataDir: string): Promise<void> {
    try {
      // Pull before anything is written: a registry failure leaves the node exactly as it was. The
      // pulled image is also the helper's image, so it is present by construction.
      await this.runDockerCommand(['docker', 'pull', imageRef], process.env);
      this.logger.info(`Successfully pulled ${imageRef}`);
    } catch (error) {
      this.logger.error('Failed to pull new Hub image', error);
      throw error;
    }

    const updateLogPath = this.stackUpdateLogPath(dataDir);
    fs.appendFileSync(
      updateLogPath,
      `\n[${new Date().toISOString()}] Hub stack update recreate (target=${imageRef}, service=${plan.service}, project=${plan.project}, via updater container)\n`,
    );

    const previousEnv = this.pinHubStackVersionInEnv(envFile, version);
    const envContent = this.readEnvFile(envFile) ?? '';
    const composeEnv: Record<string, string> = {};
    for (const key of ['DOCKER_CONFIG', 'DOCKER_HOST'] as const) {
      const value = process.env[key];
      if (value) composeEnv[key] = value;
    }
    composeEnv.CI_HUB_IMAGE = imageRef;
    composeEnv.CI_HUB_VERSION = version;
    // Absolute host paths: a relative `.env` resolves against the project directory, which is not
    // where the env file lives on a source checkout (core-4, core-14).
    composeEnv.ENV_FILE = plan.envFileHost;
    if (plan.composeFileHost) composeEnv.COMPOSE_FILE_HOST = plan.composeFileHost;
    // ROOT_FOLDER_HOST is `:?`-required by the compose file. When the launcher supplied it from its
    // shell instead of the env file, the value this container was created with is the faithful one.
    if (readEnvFileValue(envContent, 'ROOT_FOLDER_HOST') === null && process.env.ROOT_FOLDER_HOST) {
      composeEnv.ROOT_FOLDER_HOST = process.env.ROOT_FOLDER_HOST;
    }

    const helperName = stackUpdaterContainerName(plan.container);
    const script = buildStackUpdaterScript({
      plan,
      targetImage: imageRef,
      composeEnv,
      logPath: updateLogPath,
      envFilePath: envFile,
      startDelaySeconds: HELPER_START_DELAY_SECONDS,
    });
    const runArgs = buildStackUpdaterRunArgs({
      helperName,
      hubContainer: plan.container,
      image: imageRef,
      mirrorPaths: plan.mirrorPaths,
      envKeys: previousEnv === undefined ? [] : [ENV_RESTORE_VARIABLE],
      script,
    });
    const helperEnv: NodeJS.ProcessEnv = { ...process.env };
    if (previousEnv !== undefined) helperEnv[ENV_RESTORE_VARIABLE] = Buffer.from(previousEnv, 'utf8').toString('base64');

    // A leftover from an interrupted run would block the name. Plain `rm` (no `-f`) so a helper
    // that is mid-recreate right now is left alone — the run below then fails on the name
    // conflict, which is the correct answer to "update while an update is running".
    try {
      await this.runDockerCommand(['docker', 'rm', helperName], process.env);
    } catch {
      // Nothing to remove, or it is running — either way the run below decides.
    }

    this.logger.info(`Recreating ${plan.service} from ${imageRef} (logging to ${updateLogPath})...`);
    try {
      await this.runDockerCommand(['docker', ...runArgs], helperEnv);
      this.logger.info(`Stack updater container ${helperName} started; it recreates the Hub from outside this container`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start stack updater container ${helperName}`, error);
      fs.appendFileSync(updateLogPath, `updater container failed to start: ${message}\n`);
      this.restoreEnvFile(envFile, previousEnv);
      throw new InternalServerErrorException(`The stack updater container could not start, so nothing was changed: ${message}`);
    }
  }

  private runDockerCapture(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const cmd = spawn('docker', args, { stdio: 'pipe', env: process.env });
      const stdout: string[] = [];
      const stderr: string[] = [];
      cmd.stdout.on('data', (data: Buffer) => stdout.push(String(data)));
      cmd.stderr.on('data', (data: Buffer) => stderr.push(String(data)));
      cmd.on('error', reject);
      cmd.on('close', (code) => {
        if (code === 0) resolve(stdout.join(''));
        else reject(new Error(`docker ${args[0]} exited with code ${code}: ${stderr.join('').trim()}`));
      });
    });
  }

  private async runDockerCommand(command: string[], env: NodeJS.ProcessEnv): Promise<void> {
    const [bin, ...args] = command;
    if (!bin) {
      throw new Error('Empty command');
    }
    return new Promise((resolve, reject) => {
      const cmd = spawn(bin, args, { stdio: 'pipe', env });
      const stderr: string[] = [];
      cmd.stderr.on('data', (data: Buffer) => {
        this.logger.debug(`docker: ${String(data).trim()}`);
        stderr.push(String(data).trim());
      });
      cmd.stdout.on('data', (data: Buffer) => {
        this.logger.debug(`docker: ${String(data).trim()}`);
      });
      cmd.on('error', reject);
      cmd.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`docker exited with code ${code}: ${stderr.join('\n')}`));
        }
      });
    });
  }

  /**
   * The per-node switch: `autoUpdates` in `<ROOT_FOLDER_HOST>/state/settings.json`, default on. Read
   * from disk at every check, so a hand edit applies without a restart.
   */
  getAutoUpdatesEnabled(): boolean {
    try {
      const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return settings.autoUpdates !== false; // default true
      }
    } catch {
      // ignore
    }
    return true;
  }

  async setAutoUpdatesEnabled(enabled: boolean): Promise<void> {
    // Neither the controller body nor the MCP input is validated before this. `{"enabled": "false"}`
    // used to be stored as a string, which the read above treats as on and the settings schema drops.
    if (typeof enabled !== 'boolean') {
      throw new BadRequestException('enabled must be true or false');
    }
    const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
    let settings: Record<string, unknown> = {};
    try {
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
    } catch {
      // ignore
    }
    settings.autoUpdates = enabled;
    await writeSettingsJsonFile(settingsPath, JSON.stringify(settings, null, 2));
  }

  private async autoUpdateCheck() {
    this.logger.info('Running scheduled auto-update check...');
    try {
      const { updateAvailable, latest, current, updateBlockedReason } = await this.checkForUpdates();
      this.logger.info(`Auto-update check: current=${current}, latest=${latest}, updateAvailable=${updateAvailable}`);

      if (updateBlockedReason) {
        this.logger.info(`Auto-update skipped: ${updateBlockedReason}`);
        return;
      }
      if (!updateAvailable) {
        return;
      }
      if (!this.getAutoUpdatesEnabled()) {
        this.logger.info(`Auto-update skipped: autoUpdates is off for this node (${latest} is available)`);
        return;
      }
      this.logger.info(`Auto-updating hub from ${current} to ${latest}`);
      await this.performUpdate(latest);
    } catch (error) {
      this.logger.error('Auto-update check failed', error);
    }
  }

  /** Token for the desktop host update listener (Hub POSTs to host.docker.internal:17400). */
  getHostUpdateListenerToken(): string | null {
    const tokenPath = path.join(DATA_DIR, UPDATE_LISTENER_TOKEN_FILENAME);
    if (!fs.existsSync(tokenPath)) {
      return null;
    }
    try {
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      return token || null;
    } catch {
      return null;
    }
  }
}
