import { spawn } from 'node:child_process';
import { ipOnHubNetwork } from '@/common/constants';
import { appUrnLabelSets, listContainersMatchingAnyLabelSets, managedAppLabelSets } from './hub-container-query';
import { pLimit } from '@/common/helpers/file-helpers';
import { withTimeout } from '@/common/helpers/with-timeout';
import { LoggerService } from '@/core/logger/logger.service';
import { Inject, Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type Dockerode from 'dockerode';
import { DOCKERODE } from './constants';
import {
  managedAppStatusFromSummary,
  summarizeManagedAppContainers,
  type ManagedAppContainerAppStatus,
  type ManagedAppContainerSummary,
} from './managed-app-containers';

export type ManagedAppContainerVerification = {
  ok: boolean;
  appStatus: ManagedAppContainerAppStatus;
  summary: ManagedAppContainerSummary;
  message: string;
  errorDetail?: string;
};

const DOCKER_INSPECT_TIMEOUT_MS = 5_000;
const DOCKER_STATS_TIMEOUT_MS = 5_000;
/** Container list states where docker stats() is skipped (crash-loops can hang indefinitely). */
const SKIP_DOCKER_STATS_STATES = new Set(['restarting', 'created', 'dead']);

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
  exitCode: number | null;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
}

export interface AppNetworkTarget {
  url: string;
  internalPort: number;
}

/**
 * Read-only Docker status/stats facade.
 *
 * Intentionally depends only on Dockerode + logger (no AppsService) so status/UI
 * paths can avoid the Docker ↔ Apps cycle that mutate/compose paths still need.
 */
@Injectable()
export class DockerReadFacade {
  constructor(
    private readonly logger: LoggerService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
  ) {}

  /**
   * Derive the Docker Compose project name used by CI-Hub for a given app URN.
   *
   * @param appUrn - App URN (for example, "my-app:store")
   * @returns Compose project name used for labels and docker compose --project-name
   */
  public getComposeProjectName(appUrn: AppUrn): string {
    return appUrn.replace(':', '_');
  }

  private shouldSkipDockerStats(containerState: string): boolean {
    return SKIP_DOCKER_STATS_STATES.has(containerState.toLowerCase());
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

  public async getAppRuntimeStats(appUrn: AppUrn): Promise<AppContainerRuntimeStats[]> {
    const projectName = this.getComposeProjectName(appUrn);
    return this.getComposeProjectRuntimeStats(projectName, appUrn);
  }

  public async getHubRuntimeStats(): Promise<AppContainerRuntimeStats[]> {
    return this.getComposeProjectRuntimeStats('ci-hub', 'ci-hub');
  }

  private async getComposeProjectRuntimeStats(projectName: string, logLabel: string): Promise<AppContainerRuntimeStats[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${projectName}`] },
    });

    const results = await Promise.all(
      containers.map((container) =>
        (async () => {
          const dockerContainer = this.docker.getContainer(container.Id);
          const inspect = await withTimeout(dockerContainer.inspect(), DOCKER_INSPECT_TIMEOUT_MS, `Docker inspect timed out for ${container.Id}`);

          let stats: DockerStatsSnapshot | null = null;
          const skipStats = this.shouldSkipDockerStats(container.State) || !inspect.State?.Running;
          if (!skipStats) {
            try {
              stats = (await withTimeout(
                dockerContainer.stats({ stream: false }),
                DOCKER_STATS_TIMEOUT_MS,
                `Docker stats timed out for ${container.Id}`,
              )) as DockerStatsSnapshot;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this.logger.warn(`Skipping runtime stats for container ${container.Id} (${logLabel}): ${message}`);
            }
          }

          const usage = stats?.memory_stats?.usage ?? 0;
          const cache = stats?.memory_stats?.stats?.cache ?? 0;
          return {
            containerId: container.Id,
            name: container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12),
            state: container.State,
            status: container.Status,
            health: inspect.State?.Health?.Status ?? null,
            exitCode: inspect.State?.Running ? null : (inspect.State?.ExitCode ?? null),
            cpuPercent: Number(this.calculateCpuPercent((stats ?? {}) as DockerStatsSnapshot).toFixed(2)),
            memoryUsageBytes: Math.max(usage - cache, 0),
            memoryLimitBytes: stats?.memory_stats?.limit ?? 0,
          };
        })().catch((error) => {
          if (this.isResourceMissingError(error)) {
            this.logger.warn(`Skipping runtime stats for disappearing container ${container.Id} (${logLabel}): ${error}`);
            return null;
          }

          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('timed out')) {
            this.logger.warn(`Skipping runtime stats for container ${container.Id} (${logLabel}): ${message}`);
            return null;
          }

          throw error;
        }),
      ),
    );

    return results.filter((result): result is AppContainerRuntimeStats => result !== null);
  }

  public async getAppNetworkTarget(appUrn: AppUrn): Promise<AppNetworkTarget | null> {
    const containers = await listContainersMatchingAnyLabelSets(this.docker, appUrnLabelSets(appUrn, ['traefik.enable=true']), false);

    const limit = pLimit(5);
    const targets = await Promise.all(
      containers.map((containerInfo) =>
        limit(async () => {
          const inspect = await this.docker.getContainer(containerInfo.Id).inspect();
          const labels = inspect.Config?.Labels || {};
          const containerIP = ipOnHubNetwork(inspect.NetworkSettings?.Networks);

          if (!containerIP) {
            return null;
          }

          const portEntry = Object.entries(labels).find(
            ([key]) => key.startsWith('traefik.http.services.') && key.endsWith('.loadbalancer.server.port'),
          );

          if (!portEntry) {
            return null;
          }

          const serviceName = portEntry[0].replace('traefik.http.services.', '').replace('.loadbalancer.server.port', '');
          const internalPort = Number.parseInt(String(portEntry[1]), 10);

          if (Number.isNaN(internalPort)) {
            return null;
          }

          const backendScheme = labels[`traefik.http.services.${serviceName}.loadbalancer.server.scheme`];
          const scheme = backendScheme === 'https' ? 'https+insecure' : 'http';

          return {
            url: `${scheme}://${containerIP}:${internalPort}`,
            internalPort,
          } satisfies AppNetworkTarget;
        }),
      ),
    );

    return targets.find((target): target is AppNetworkTarget => target !== null) ?? null;
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
   * Verify Hub-labeled containers exist and match the same running/stopped/missing
   * rules used by app status sync (ci-hub.managed + ci-hub.appurn labels, plus the retired ci-os-hub spellings).
   */
  public async getManagedAppContainerVerification(appUrn: AppUrn): Promise<ManagedAppContainerVerification> {
    const containers = await listContainersMatchingAnyLabelSets(this.docker, managedAppLabelSets(appUrn));

    const summary = summarizeManagedAppContainers(containers);
    const appStatus = managedAppStatusFromSummary(summary);

    if (appStatus === 'running') {
      return {
        ok: true,
        appStatus,
        summary,
        message: 'All containers are running',
      };
    }

    const diagResults = appStatus === 'missing' ? { unhealthy: [], healthy: [] } : await this.diagnoseAppContainers(appUrn);
    const logSummary =
      diagResults.unhealthy.length > 0
        ? diagResults.unhealthy.map((container) => `${container.name} (${container.state}): ${container.logs}`).join('\n')
        : undefined;

    if (appStatus === 'missing') {
      return {
        ok: false,
        appStatus,
        summary,
        message: 'Install finished but no Hub-managed containers were found. The app may have failed to start.',
        errorDetail: logSummary,
      };
    }

    return {
      ok: false,
      appStatus,
      summary,
      message: 'One or more containers exited after install.',
      errorDetail: logSummary,
    };
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
