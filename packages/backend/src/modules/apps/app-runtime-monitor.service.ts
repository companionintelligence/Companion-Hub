import { LoggerService } from '@/core/logger/logger.service';
import { withTimeout } from '@/common/helpers/with-timeout';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type { App } from '@/core/database/drizzle/types';
import si from 'systeminformation';
import { AppsRepository } from './apps.repository';
import { AppsService } from './apps.service';
import { DockerReadFacade, type AppContainerRuntimeStats } from '../docker/docker-read.facade';
import { HostTelemetryService } from '../system/host-telemetry.service';
import type { PoolContainerRollup, PoolContainerSampler } from '@/common/helpers/hub-pool';

const HIGH_CPU_THRESHOLD_PERCENT = 90;
const HIGH_CPU_SAMPLE_COUNT = 3;
const MONITOR_INTERVAL_MS = 60_000;
const MONITOR_HISTORY_LIMIT = 24;
const SNAPSHOT_CACHE_TTL_MS = 30_000;
const SNAPSHOT_COLLECTION_DEADLINE_MS = 30_000;
const PROCESS_SCAN_TIMEOUT_MS = 3_000;
const STOPPING_GRACE_MS = 30_000;
const AVAILABILITY_PROBE_CACHE_TTL_MS = 60_000;
/**
 * How old the last successful sample may be and still be published to pool peers.
 *
 * Two monitor intervals: one missed tick is a slow Docker call, two is a monitor that has stopped
 * producing. Past it {@link AppRuntimeMonitorService.containerRollup} returns `null` and the pool
 * omits the key, because a figure that old is not "what this box is running", it is what it was
 * running. Deliberately keyed off MONITOR_INTERVAL_MS — the thing that actually refreshes the
 * sample — and not off the pool's own inventory TTL, which governs a different cache entirely.
 */
const CONTAINER_ROLLUP_MAX_AGE_MS = 2 * MONITOR_INTERVAL_MS;
/**
 * Marks the synthetic entry {@link AppRuntimeMonitorService.collectHubRuntimeHealth} adds for the
 * backend's own Node process on a Hub that is not itself containerised. It is a process, not a
 * container, so anything counting containers must exclude it.
 */
const PROCESS_RUNTIME_ID_PREFIX = 'pid:';

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
export class AppRuntimeMonitorService implements OnModuleInit, OnModuleDestroy, PoolContainerSampler {
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
    private readonly dockerReadFacade: DockerReadFacade,
    @Optional() private readonly telemetry?: HostTelemetryService,
  ) {}

  onModuleInit() {
    void this.hydrateHistoryFromDatabase()
      .then(() => this.collectRuntimeMonitorSnapshot(true))
      .catch((error) => {
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
    await this.hydrateHistoryFromDatabase();
    return this.collectRuntimeMonitorSnapshot();
  }

  /**
   * The last collected sample reduced to counts and totals, for the Hub pool's capability payload,
   * or `null` when there is nothing recent enough to publish.
   *
   * Cache-only and synchronous, and that is the whole point: this answers every paired peer's 30s
   * health poll, which runs under a 15s budget, and three overruns mark a healthy node
   * `unreachable`. {@link getRuntimeMonitorSnapshot} is not usable there — it awaits a database
   * hydrate and then, on a cold cache, a full Docker fan-out bounded at 30s. So this reads only
   * what the {@link MONITOR_INTERVAL_MS} timer has already collected and never probes anything.
   *
   * Reading a sampled value is a feature here rather than a compromise: peers poll every 30s and
   * the monitor samples every 60s, so a rollup is at most one sampling cycle behind, which is the
   * right resolution for "how loaded is that box" and costs the poll path nothing.
   *
   * `null` — never zeros — for every way this can fail to know, and each one is a real state:
   *   - nothing sampled yet (the warmup after boot has not finished)
   *   - the last sample is older than {@link CONTAINER_ROLLUP_MAX_AGE_MS}, so collection is failing
   *
   * Judged on `latestSnapshot.sampledAt`, which is stamped only where a collection SUCCEEDED, and
   * pointedly not on `latestSnapshotAtMs`, which `collectRuntimeMonitorSnapshot` bumps on the
   * failure path while handing back old data — that field would report an hour-dead Docker as
   * current. `latestSnapshot` itself is never assigned from `emptySnapshot()`, so a total failure
   * with no prior sample stays `null` here instead of arriving as a believable "0 containers".
   */
  containerRollup(now: number = Date.now()): PoolContainerRollup | null {
    const snapshot = this.latestSnapshot;
    if (!snapshot) {
      return null;
    }

    const sampledAtMs = Date.parse(snapshot.sampledAt);
    if (!Number.isFinite(sampledAtMs) || now - sampledAtMs > CONTAINER_ROLLUP_MAX_AGE_MS) {
      return null;
    }

    // Leaf containers, not the per-app aggregates: the Hub entity folds the synthetic Node-process
    // entry into its own cpuPercent, so summing app totals would count a process the container
    // count excludes and put the two halves of this payload on different populations.
    const containers = snapshot.apps
      .flatMap((app) => app.containers)
      .filter((container) => !container.containerId.startsWith(PROCESS_RUNTIME_ID_PREFIX));
    const running = containers.filter((container) => container.state === 'running').length;

    return {
      running,
      // Everything that exists and is not running. Docker's state enum is wider than two values, so
      // this bucket also holds `paused`, `created` and `restarting`; that is stated on
      // `PoolContainerRollup` and is what keeps `running + stopped === total` true.
      stopped: containers.length - running,
      total: containers.length,
      cpuPercent: Number(containers.reduce((sum, container) => sum + container.cpuPercent, 0).toFixed(2)),
      memoryBytes: containers.reduce((sum, container) => sum + container.memoryUsageBytes, 0),
    };
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

    void this.telemetry?.recordRuntimeApps(sampledAt, historySample.apps);

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
      const hubContainers = await this.dockerReadFacade.getHubRuntimeStats();
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
              containerId: `${PROCESS_RUNTIME_ID_PREFIX}${process.pid}`,
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
        appName: 'CI Hub',
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
    const containers = await this.dockerReadFacade.getAppRuntimeStats(appUrn);
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

  private async hydrateHistoryFromDatabase() {
    if (!this.telemetry || this.history.length > 0) {
      return;
    }
    try {
      const stored = await this.telemetry.getRuntimeHistory(MONITOR_HISTORY_LIMIT);
      for (const sample of stored) {
        this.history.push({ sampledAt: sample.sampledAt, apps: sample.apps });
      }
    } catch (error) {
      this.logger.warn(`App runtime monitor history hydrate failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
        void this.telemetry?.recordEvent('warn', 'app-monitor', `Hub degraded by ${degradedApp.appName}`, {
          appUrn: degradedApp.appUrn,
          cpuPercent: degradedApp.cpuPercent,
          reason: degradedApp.reason,
        });
      }
    } catch (error) {
      this.logger.warn(`App runtime monitor summary failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
