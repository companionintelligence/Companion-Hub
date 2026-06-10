import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type { App } from '@/core/database/drizzle/types';
import { AppsRepository } from './apps.repository';
import { AppsService } from './apps.service';
import { DockerService, type AppContainerRuntimeStats } from '../docker/docker.service';

const HIGH_CPU_THRESHOLD_PERCENT = 90;
const HIGH_CPU_SAMPLE_COUNT = 3;
const MONITOR_INTERVAL_MS = 60_000;
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

@Injectable()
export class AppRuntimeMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly samples = new Map<string, RuntimeSample[]>();
  private readonly availabilityProbeCache = new Map<string, AvailabilityProbeCacheEntry>();
  private intervalHandle: NodeJS.Timeout | null = null;
  private summaryInFlight = false;

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly appsRepository: AppsRepository,
    private readonly appsService: AppsService,
    private readonly dockerService: DockerService,
  ) {}

  onModuleInit() {
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

  async getRuntimeMonitorSnapshot(): Promise<{ sampledAt: string; apps: AppRuntimeHealth[] }> {
    const apps = await this.appsRepository.getApps();
    const snapshots = await Promise.all(apps.filter((app) => app.status !== 'missing').map((app) => this.collectAppRuntimeHealthForApp(app)));

    return {
      sampledAt: new Date().toISOString(),
      apps: snapshots.sort((a, b) => b.cpuPercent - a.cpuPercent || a.appName.localeCompare(b.appName)),
    };
  }

  async getAppRuntimeHealth(appUrn: AppUrn): Promise<AppRuntimeHealth> {
    const app = await this.appsRepository.getAppByUrn(appUrn);
    if (!app) {
      throw new Error(`App ${appUrn} not found`);
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
      const { apps } = await this.getRuntimeMonitorSnapshot();
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
