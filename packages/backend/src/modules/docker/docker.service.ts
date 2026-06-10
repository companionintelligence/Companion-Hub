import { spawn } from 'node:child_process';
import path from 'node:path';
import { DEFAULT_HUB_CONTAINER_NAME, DEFAULT_NETWORK_NAME } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, InternalServerErrorException, Inject, forwardRef } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type Dockerode from 'dockerode';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsService } from '../apps/apps.service';
import { DOCKERODE } from './constants';

interface DockerCpuStatsSnapshot {
  cpu_usage?: {
    total_usage?: number;
    percpu_usage?: number[];
  };
  system_cpu_usage?: number;
  online_cpus?: number;
}

interface DockerMemoryStatsSnapshot {
  usage?: number;
  limit?: number;
  stats?: {
    cache?: number;
  };
}

interface DockerStatsSnapshot {
  cpu_stats?: DockerCpuStatsSnapshot;
  precpu_stats?: DockerCpuStatsSnapshot;
  memory_stats?: DockerMemoryStatsSnapshot;
}

export interface AppContainerRuntimeStats {
  containerId: string;
  name: string;
  state: string;
  status: string;
  health: string | null;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
}

@Injectable()
export class DockerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    @Inject(forwardRef(() => AppFilesManager)) private readonly appFilesManager: AppFilesManager,
    private readonly filesystem: FilesystemService,
    @Inject(forwardRef(() => AppsService)) private readonly appsService: AppsService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
  ) {}

  /**
   * Derive the Docker Compose project name used by CI-Hub for a given app URN.
   *
   * @param appUrn - App URN (for example, "my-app:store")
   * @returns Compose project name used for labels and docker compose --project-name
   */
  private getComposeProjectName(appUrn: AppUrn): string {
    return appUrn.replace(':', '_');
  }

  private calculateCpuPercent(stats: DockerStatsSnapshot): number {
    const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
    const onlineCpus = stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? stats.precpu_stats?.online_cpus ?? 1;

    if (cpuDelta <= 0 || systemDelta <= 0 || onlineCpus <= 0) {
      return 0;
    }

    return (cpuDelta / systemDelta) * onlineCpus * 100;
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

  public async getAppRuntimeStats(appUrn: AppUrn): Promise<AppContainerRuntimeStats[]> {
    const projectName = this.getComposeProjectName(appUrn);
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${projectName}`] },
    });

    return Promise.all(
      containers.map(async (container) => {
        const inspect = await this.docker.getContainer(container.Id).inspect();
        const stats = inspect.State?.Running
          ? ((await this.docker.getContainer(container.Id).stats({ stream: false })) as DockerStatsSnapshot)
          : null;

        const usage = stats?.memory_stats?.usage ?? 0;
        const cache = stats?.memory_stats?.stats?.cache ?? 0;
        return {
          containerId: container.Id,
          name: container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12),
          state: container.State,
          status: container.Status,
          health: inspect.State?.Health?.Status ?? null,
          cpuPercent: Number(this.calculateCpuPercent((stats ?? {}) as DockerStatsSnapshot).toFixed(2)),
          memoryUsageBytes: Math.max(usage - cache, 0),
          memoryLimitBytes: stats?.memory_stats?.limit ?? 0,
        };
      }),
    );
  }

  public async forceStopApp(appUrn: AppUrn, graceSeconds = 5): Promise<{ stopped: string[]; killed: string[] }> {
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
   * Get the base compose args for an app

   * @param {string} appUrn - App name
   */
  public getBaseComposeArgsApp = async (appUrn: AppUrn) => {
    let isCustomConfig = false;

    const appEnv = await this.appFilesManager.getAppEnv(appUrn);
    const args: string[] = ['--env-file', appEnv.path];

    const { app } = await this.appsService.getApp(appUrn);
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
   * Helpers to execute docker compose commands
   * @param {string} appUrn - App name
   * @param {string} command - Command to execute
   */
  public async composeApp(appUrn: AppUrn, command: string) {
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
      // Verify docker compose is available before using it
      const testCmd = spawn('docker', ['compose', 'version'], { stdio: 'pipe' });
      await new Promise<void>((resolve, reject) => {
        testCmd.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`docker compose not available (exit code: ${code})`));
          }
        });
        testCmd.on('error', reject);
      });

      this.logger.debug('docker compose plugin is available, using it');
      // Use docker compose plugin (docker-cli is installed in the container)
      return this.runDockerCompose(['docker', 'compose', ...args], composeDir, isCustomConfig);
    } catch (_error) {
      // Fallback to docker-compose binary if docker compose plugin is not available
      this.logger.warn('docker compose plugin not available, falling back to docker-compose binary');
      return this.runDockerCompose(['docker-compose', ...args], composeDir, isCustomConfig).catch((fallbackError: unknown) => {
        const err = fallbackError as Error & { code?: string };
        throw new Error(`Both docker compose and docker-compose failed: ${err.message || String(fallbackError)}`);
      });
    }
  }

  private async runDockerCompose(command: string[], cwd: string, isCustomConfig: boolean) {
    // Log the full command for debugging
    this.logger.debug(`Executing: ${command[0]} ${command.slice(1).join(' ')}`);

    if (!command[0]) {
      throw new Error('Command is empty');
    }

    const cmd = spawn(command[0], command.slice(1), {
      cwd, // Set working directory to compose file's directory
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await new Promise<number>((resolve, reject) => {
      cmd.on('error', (error: NodeJS.ErrnoException) => {
        this.logger.error(`Failed to spawn ${command[0]}: ${error.message}`);
        if (error.code === 'ENOEXEC') {
          this.logger.error(`${command[0]} binary cannot be executed. This usually means the binary is corrupted or for the wrong architecture.`);
        }
        reject(error);
      });
      cmd.stdout.on('data', (data: Buffer | string) => {
        this.logger.debug(`${command[0]}: ${String(data).trim()}`);
        stdout.push(String(data).trim());
      });
      cmd.stderr.on('data', (data: Buffer | string) => {
        this.logger.debug(`${command[0]}: ${String(data).trim()}`);
        stderr.push(String(data).trim());
      });
      cmd.on('close', resolve);
    });

    if (exitCode !== 0) {
      this.logger.info(`${command[0]} exited with code ${exitCode}`);
      if (isCustomConfig) {
        this.logger.warn('User-config detected, please make sure your configuration is correct before opening an issue');
      }
      const error = stderr.pop();
      throw new Error(error);
    }

    return { success: true, stdout: stdout.join(''), stderr: stderr.join('') };
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
   * Returns true if the named container exists and its status is exactly
   * "running" (i.e. not paused, restarting, exited, or in any other state).
   *
   * `.State.Status` is the canonical status string Docker maintains and is
   * set to "running" only when the container is fully up and not paused or
   * mid-restart — unlike `.State.Running`, which remains `true` for paused
   * and restarting containers as well.
   */
  public async isContainerRunning(containerName: string): Promise<boolean> {
    return new Promise((resolve) => {
      const cmd = spawn('docker', ['inspect', '--format', '{{.State.Status}}', containerName]);
      const chunks: string[] = [];
      cmd.stdout.on('data', (data: Buffer) => chunks.push(String(data)));
      cmd.on('close', (code) => resolve(code === 0 && chunks.join('').trim() === 'running'));
      cmd.on('error', () => resolve(false));
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
    } catch {
      this.logger.info(`Container ${containerName} not found, creating via docker compose...`);
      await this.composeUpService(containerName, opts);
    }
  }

  private async composeUpService(serviceName: string, opts: { composeFile: string; profile?: string }): Promise<void> {
    const args = ['compose'];
    const runtimeComposeFile = path.join(this.config.get('directories').dataDir, 'docker-compose.yml');
    const spawnOptions: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: path.dirname(opts.composeFile) };

    if (opts.composeFile === runtimeComposeFile) {
      const envFilePath = this.config.get('envFilePath');
      args.push('--env-file', envFilePath);
      // Match the project name used by start.ts / package.json scripts so
      // compose attaches to the running stack instead of creating a new one.
      const composeProjectName = process.env.CI_HUB_COMPOSE_PROJECT_NAME || 'ci-hub';
      args.push('--project-name', composeProjectName);

      // When running inside the Hub container, docker compose resolves relative
      // binds (e.g. ./tunnel) against /data. The host daemon then interprets
      // those as /data/* on the host, which is not the real Hub data dir.
      // Point compose at the host project directory so relative binds resolve
      // to ROOT_FOLDER_HOST (for example /home/.../.local/share/companion-hub).
      const hostProjectDir = process.env.ROOT_FOLDER_HOST?.trim();
      if (hostProjectDir) {
        args.push('--project-directory', hostProjectDir);
      }

      // Override ENV_FILE to just the filename so compose's env_file
      // directive resolves correctly inside the container.
      spawnOptions.env = { ...process.env, ENV_FILE: path.basename(envFilePath) };
    }

    args.push('-f', opts.composeFile);

    if (opts.profile) {
      args.push('--profile', opts.profile);
    }
    args.push('up', serviceName, '-d', '--no-build', '--no-deps');

    return new Promise((resolve, reject) => {
      this.logger.info(`Running: docker ${args.join(' ')}`);
      const cmd = spawn('docker', args, spawnOptions);

      let stderr = '';
      cmd.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      cmd.on('close', (code) => {
        if (code === 0) {
          this.logger.info(`Service ${serviceName} started successfully via docker compose`);
          resolve();
        } else {
          this.logger.error(`Failed to start service ${serviceName}: ${stderr}`);
          reject(new Error(`Failed to start service ${serviceName} via docker compose`));
        }
      });

      cmd.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Diagnose app containers after startup - check for crash-loops, exited containers, and capture logs
   * @param appUrn - The app URN
   * @returns Diagnostic results with unhealthy container info
   */
  public async diagnoseAppContainers(appUrn: AppUrn): Promise<{
    unhealthy: Array<{ name: string; state: string; logs: string }>;
    healthy: string[];
  }> {
    const projectName = this.getComposeProjectName(appUrn);
    const result: { unhealthy: Array<{ name: string; state: string; logs: string }>; healthy: string[] } = {
      unhealthy: [],
      healthy: [],
    };

    try {
      // List containers for this compose project
      const listCmd = spawn('docker', [
        'ps',
        '-a',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.Names}}|{{.Status}}',
      ]);

      const output = await new Promise<string>((resolve, reject) => {
        const chunks: string[] = [];
        listCmd.stdout.on('data', (data: Buffer) => chunks.push(String(data)));
        listCmd.stderr.on('data', (data: Buffer) => this.logger.debug(`docker ps stderr: ${String(data)}`));
        listCmd.on('close', (code) => {
          if (code === 0) resolve(chunks.join(''));
          else reject(new Error(`docker ps failed with code ${code}`));
        });
        listCmd.on('error', reject);
      });

      const lines = output.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const [containerName, status] = line.split('|');
        if (!containerName || !status) continue;

        const isUnhealthy = status.includes('Restarting') || status.includes('Exited') || status.includes('Created') || status.includes('Dead');

        if (isUnhealthy) {
          // Capture last 20 lines of logs
          let logs = '';
          try {
            const logCmd = spawn('docker', ['logs', '--tail', '20', containerName]);
            logs = await new Promise<string>((resolve, _reject) => {
              const chunks: string[] = [];
              logCmd.stdout.on('data', (data: Buffer) => chunks.push(String(data)));
              logCmd.stderr.on('data', (data: Buffer) => chunks.push(String(data)));
              logCmd.on('close', () => resolve(chunks.join('').trim()));
              logCmd.on('error', () => resolve('(failed to capture logs)'));
            });
          } catch {
            logs = '(failed to capture logs)';
          }

          this.logger.warn(`[AppDiag] Container ${containerName} is ${status}`);
          if (logs) {
            this.logger.warn(`[AppDiag] ${containerName} logs:\n${logs}`);
          }

          result.unhealthy.push({ name: containerName, state: status, logs });
        } else {
          result.healthy.push(containerName);
        }
      }
    } catch (error) {
      this.logger.error(`[AppDiag] Failed to diagnose containers for ${appUrn}: ${error}`);
    }

    return result;
  }
}
