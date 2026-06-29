import { LoggerService } from '@/core/logger/logger.service';
import { withTimeout } from '@/common/helpers/with-timeout';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type { App } from '@/core/database/drizzle/types';
import si from 'systeminformation';
import { AppsRepository } from './apps.repository';
import { AppsService } from './apps.service';
import { DockerService, type AppContainerRuntimeStats } from '../docker/docker.service';

const HIGH_CPU_THRESHOLD_PERCENT = 90;
const HIGH_CPU_SAMPLE_COUNT = 3;
const MONITOR_INTERVAL_MS = 60_000;
const MONITOR_HISTORY_LIMIT = 24;
const SNAPSHOT_CACHE_TTL_MS = 30_000;
const SNAPSHOT_COLLECTION_DEADLINE_MS = 30_000;
const PROCESS_SCAN_TIMEOUT_MS = 3_000;
const STOPPING_GRACE_MS = 30_000;
const AVAILABILITY_PROBE_CACHE_TTL_MS = 60_000;

type RuntimeSample = {
  sampledAtMs: number;
  cpuPercent: number;
  responsive: boolean;
};

type AvailabilityProbeCacheEntry = {
  sampledAtMs: number;
  responsive: boolean;
  reason: string | null;
};

export type AppRuntimeHealth = {
  appUrn: string;
  appName: string;
  status: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  highCpu: boolean;
  sustainedHighCpu: boolean;
  responsive: boolean;
  degraded: boolean;
  forceStopEligible: boolean;
  reason: string | null;
  cpuLimit: string | null;
  usesDefaultCpuLimit: boolean;
  sampledAt: string;
  containers: AppContainerRuntimeStats[];
};

export type AppRuntimeHistoryPoint = {
  appUrn: string;
  appName: string;
  status: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  containerCount: number;
};

export type AppRuntimeHistorySample = {
  sampledAt: string;
  apps: AppRuntimeHistoryPoint[];
};

export type AppRuntimeMonitorSnapshot = {
  sampledAt: string;
  apps: AppRuntimeHealth[];
  history: AppRuntimeHistorySample[];
};

const HUB_RUNTIME_URN = 'ci-hub:system';

@Injectable()
export class AppRuntimeMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly samples = new Map<string, RuntimeSample[]>();
  private readonly availabilityProbeCache = new Map<string, AvailabilityProbeCacheEntry>();
  private readonly history: AppRuntimeHistorySample[] = [];
  private intervalHandle: NodeJS.Timeout | null = null;
  private latestSnapshot: AppRuntimeMonitorSnapshot | null = null;
  private latestSnapshotAtMs = 0;
  private summaryInFlight = false;

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly appsRepository: AppsRepository,
    private readonly appsService: AppsService,
    private readonly dockerService: DockerService,
  ) {}

  onModuleInit() {
    void this.collectRuntimeMonitorSnapshot(true).catch((error) => {
      this.logger.warn(`App runtime monitor warmup failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    this.intervalHandle = setInterval(() => {
      if (this.summaryInFlight) {
        return;
      }

      this.summaryInFlight = true;
      void this.logRuntimeSummary().finally(() => {
        this.summaryInFlight = false;
      });
    }, MONITOR_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async getRuntimeMonitorSnapshot(): Promise<AppRuntimeMonitorSnapshot> {
    return this.collectRuntimeMonitorSnapshot();
  }

  private emptySnapshot(): AppRuntimeMonitorSnapshot {
    return {
      sampledAt: new Date().toISOString(),
      apps: [],
      history: [...this.history],
    };
  }

  private async collectRuntimeMonitorSnapshot(force = false): Promise<AppRuntimeMonitorSnapshot> {
    if (!force && this.latestSnapshot && Date.now() - this.latestSnapshotAtMs < SNAPSHOT_CACHE_TTL_MS) {
      return this.latestSnapshot;
    }

    try {
      return await withTimeout(
        this.collectRuntimeMonitorSnapshotInner(),
        SNAPSHOT_COLLECTION_DEADLINE_MS,
        'App runtime monitor snapshot collection timed out',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`App runtime monitor snapshot failed: ${message}`);
      if (this.latestSnapshot) {
        this.latestSnapshotAtMs = Date.now();
        return this.latestSnapshot;
      }
      return this.emptySnapshot();
    }
  }

  private async collectRuntimeMonitorSnapshotInner(): Promise<AppRuntimeMonitorSnapshot> {
    const sampledAt = new Date().toISOString();
    const apps = await this.appsRepository.getApps();
    const snapshots = await Promise.all(apps.filter((app) => app.status !== 'missing').map((app) => this.collectAppRuntimeHealthForApp(app)));
    const hubRuntime = await this.collectHubRuntimeHealth(sampledAt);
    const entities = hubRuntime ? [...snapshots, hubRuntime] : snapshots;
    const historySample: AppRuntimeHistorySample = {
      sampledAt,
      apps: entities.map((app) => ({
        appUrn: app.appUrn,
        appName: app.appName,
        status: app.status,
        cpuPercent: app.cpuPercent,
        memoryUsageBytes: app.memoryUsageBytes,
        containerCount: app.containers.length,
      })),
    };

    this.history.push(historySample);
    while (this.history.length > MONITOR_HISTORY_LIMIT) {
      this.history.shift();
    }

    this.latestSnapshot = {
      sampledAt,
      apps: entities.sort((a, b) => b.cpuPercent - a.cpuPercent || a.appName.localeCompare(b.appName)),
      history: [...this.history],
    };
    this.latestSnapshotAtMs = Date.now();
    return this.latestSnapshot;
  }

  private async collectHubRuntimeHealth(sampledAt: string): Promise<AppRuntimeHealth | null> {
    try {
      const hubContainers = await this.dockerService.getHubRuntimeStats();
      const backendProcess = this.isCurrentProcessRepresentedByHubContainers(hubContainers)
        ? null
        : await withTimeout(
            si.processes().then((processList) => processList.list.find((entry) => entry.pid === process.pid)),
            PROCESS_SCAN_TIMEOUT_MS,
            'Process scan timed out',
          ).catch((error) => {
            this.logger.warn(`Skipping backend process metrics: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          });
      if (!backendProcess && hubContainers.length === 0) {
        return null;
      }

      const processRuntime: AppContainerRuntimeStats[] = backendProcess
        ? [
            {
              containerId: `pid:${process.pid}`,
              name: 'backend-api',
              state: backendProcess.state || 'running',
              status: 'Node process',
              health: null,
              exitCode: null,
              cpuPercent: Number((backendProcess.cpu ?? 0).toFixed(2)),
              memoryUsageBytes: Math.max(Math.round((backendProcess.memRss ?? 0) * 1024), 0),
              memoryLimitBytes: 0,
            },
          ]
        : [];

      const containers = [...hubContainers, ...processRuntime];
      const cpuPercent = Number(containers.reduce((sum, container) => sum + container.cpuPercent, 0).toFixed(2));
      const memoryUsageBytes = containers.reduce((sum, container) => sum + container.memoryUsageBytes, 0);
      const memoryLimitBytes = containers.reduce((sum, container) => sum + container.memoryLimitBytes, 0);
      const recentSamples = this.rememberSample(HUB_RUNTIME_URN, {
        sampledAtMs: Date.now(),
        cpuPercent,
        responsive: true,
      });
      const sustainedHighCpu =
        recentSamples.length >= HIGH_CPU_SAMPLE_COUNT &&
        recentSamples.slice(-HIGH_CPU_SAMPLE_COUNT).every((sample) => sample.cpuPercent >= HIGH_CPU_THRESHOLD_PERCENT);

      return {
        appUrn: HUB_RUNTIME_URN,
        appName: 'Companion Hub',
        status: 'running',
        cpuPercent,
        memoryUsageBytes,
        memoryLimitBytes,
        highCpu: cpuPercent >= HIGH_CPU_THRESHOLD_PERCENT,
        sustainedHighCpu,
        responsive: true,
        degraded: false,
        forceStopEligible: false,
        reason: null,
        cpuLimit: null,
        usesDefaultCpuLimit: false,
        sampledAt,
        containers,
      };
    } catch (error) {
      this.logger.warn(`Failed to collect Hub runtime metrics: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private isCurrentProcessRepresentedByHubContainers(containers: AppContainerRuntimeStats[]): boolean {
    const hostname = process.env.HOSTNAME?.trim().toLowerCase();
    if (!hostname) {
      return false;
    }

    return containers.some((container) => {
      const containerId = container.containerId.toLowerCase();
      const containerName = container.name.toLowerCase();
      return containerId === hostname || containerId.startsWith(hostname) || containerName === hostname;
    });
  }

  async getAppRuntimeHealth(appUrn: AppUrn): Promise<AppRuntimeHealth> {
    const app = await this.appsRepository.getAppByUrn(appUrn);
    if (!app) {
      throw new NotFoundException(`App ${appUrn} not found`);
    }

    return this.collectAppRuntimeHealthForApp(app);
  }

  private rememberSample(appUrn: string, sample: RuntimeSample) {
    const existing = this.samples.get(appUrn) ?? [];
    const next = [...existing, sample].slice(-HIGH_CPU_SAMPLE_COUNT);
    this.samples.set(appUrn, next);
    return next;
  }

  private getCachedAvailabilityProbe(appUrn: string): AvailabilityProbeCacheEntry | null {
    const cached = this.availabilityProbeCache.get(appUrn);
    if (!cached) {
      return null;
    }

    if (Date.now() - cached.sampledAtMs > AVAILABILITY_PROBE_CACHE_TTL_MS) {
      this.availabilityProbeCache.delete(appUrn);
      return null;
    }

    return cached;
  }

  private async getAvailabilityForSuspiciousApp(appUrn: AppUrn): Promise<AvailabilityProbeCacheEntry> {
    const cached = this.getCachedAvailabilityProbe(appUrn);
    if (cached) {
      return cached;
    }

    const availability = await this.appsService.checkAppAvailability(appUrn);
    const nextEntry: AvailabilityProbeCacheEntry = {
      sampledAtMs: Date.now(),
      responsive: availability.available,
      reason: availability.available ? null : availability.detail || availability.errorCode || 'App availability probe failed',
    };
    this.availabilityProbeCache.set(appUrn, nextEntry);
    return nextEntry;
  }

  private async collectAppRuntimeHealthForApp(app: App): Promise<AppRuntimeHealth> {
    const appUrn = `${app.appName}:${app.appStoreSlug}` as AppUrn;

    const sampledAt = new Date().toISOString();
    const containers = await this.dockerService.getAppRuntimeStats(appUrn);
    const cpuPercent = Number(containers.reduce((sum, container) => sum + container.cpuPercent, 0).toFixed(2));
    const memoryUsageBytes = containers.reduce((sum, container) => sum + container.memoryUsageBytes, 0);
    const memoryLimitBytes = containers.reduce((sum, container) => sum + container.memoryLimitBytes, 0);
    const healthUnhealthy = containers.some((container) => container.health === 'unhealthy');
    const highCpu = cpuPercent >= HIGH_CPU_THRESHOLD_PERCENT;

    let responsive = true;
    let reason: string | null = null;

    const shouldProbeAvailability =
      (app.status === 'running' || app.status === 'restarting') && (highCpu || healthUnhealthy || app.status === 'restarting');

    if (shouldProbeAvailability) {
      const availability = await this.getAvailabilityForSuspiciousApp(appUrn);
      responsive = availability.responsive;
      reason = availability.reason;
    } else if (app.status === 'stopping' && containers.some((container) => container.state === 'running')) {
      const updatedAtMs = app.updatedAt ? Date.parse(app.updatedAt) : 0;
      const stopTimedOut = updatedAtMs > 0 && Date.now() - updatedAtMs >= STOPPING_GRACE_MS;
      responsive = !stopTimedOut;
      reason = stopTimedOut ? 'App stop exceeded the graceful timeout window' : null;
    }

    if (healthUnhealthy) {
      responsive = false;
      reason = reason || 'One or more containers are unhealthy';
    }

    const recentSamples = this.rememberSample(appUrn, {
      sampledAtMs: Date.now(),
      cpuPercent,
      responsive,
    });
    const sustainedHighCpu =
      recentSamples.length >= HIGH_CPU_SAMPLE_COUNT &&
      recentSamples.slice(-HIGH_CPU_SAMPLE_COUNT).every((sample) => sample.cpuPercent >= HIGH_CPU_THRESHOLD_PERCENT);
    const degraded = sustainedHighCpu && !responsive;

    const appCpuLimit = typeof app.config?.cpuLimit === 'string' && app.config.cpuLimit.trim() ? app.config.cpuLimit.trim() : null;
    const defaultCpuLimit =
      typeof (this.config.get('userSettings') as Record<string, unknown>).defaultAppCpuLimit === 'string'
        ? ((this.config.get('userSettings') as Record<string, unknown>).defaultAppCpuLimit as string).trim() || null
        : null;

    return {
      appUrn,
      appName: app.appName,
      status: app.status,
      cpuPercent,
      memoryUsageBytes,
      memoryLimitBytes,
      highCpu,
      sustainedHighCpu,
      responsive,
      degraded,
      forceStopEligible: degraded && highCpu,
      reason,
      cpuLimit: appCpuLimit ?? defaultCpuLimit,
      usesDefaultCpuLimit: !appCpuLimit && Boolean(defaultCpuLimit),
      sampledAt,
      containers,
    };
  }

  private async logRuntimeSummary() {
    try {
      const { apps } = await this.collectRuntimeMonitorSnapshot();
      const activeApps = apps.filter((app) => app.status === 'running' || app.status === 'stopping' || app.cpuPercent > 0);
      if (activeApps.length === 0) {
        return;
      }

      const topSummary = activeApps
        .slice(0, 5)
        .map((app) => `${app.appName} ${app.cpuPercent.toFixed(1)}% CPU`)
        .join(', ');
      this.logger.info(`[AppMonitor] CPU summary: ${topSummary}`);

      const degradedApps = activeApps.filter((app) => app.degraded);
      for (const degradedApp of degradedApps) {
        this.logger.warn(
          `[AppMonitor] Hub degraded by ${degradedApp.appName} (${degradedApp.appUrn}): ${degradedApp.cpuPercent.toFixed(1)}% CPU, ${degradedApp.reason ?? 'app unresponsive'}`,
        );
      }
    } catch (error) {
      this.logger.warn(`App runtime monitor summary failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
