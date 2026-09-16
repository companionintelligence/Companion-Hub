import { DATABASE, type Database } from '@/core/database/database.module';
import { hostEventLog, hostTelemetrySample } from '@/core/database/drizzle/schema';
import { LoggerService } from '@/core/logger/logger.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { lt } from 'drizzle-orm';
import type Dockerode from 'dockerode';
import { SystemService } from './system.service';

export const HOST_TELEMETRY_INTERVAL_MS = 5_000;
export const HOST_TELEMETRY_RETENTION_MS = 48 * 60 * 60 * 1000;
const DOCKER_INFO_CACHE_MS = 5_000;
const PRUNE_EVERY_SAMPLES = 60;

export type SlimDockerInfo = {
  ncpu?: number;
  memTotal?: number;
  memTotalMb?: number;
  containers?: number;
  containersRunning?: number;
  containersPaused?: number;
  containersStopped?: number;
  images?: number;
  serverVersion?: string;
  driver?: string;
  operatingSystem?: string;
  name?: string;
};

export type TelemetryAppPoint = {
  appUrn: string;
  appName: string;
  status: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  containerCount: number;
  /** Mirrors `AppRuntimeHistoryPoint.gpuVramMb` in `app-runtime-monitor.service.ts` — kept in sync by hand, same as every other field here. */
  gpuVramMb: number | null;
};

export type HostTelemetryHistorySample = {
  sampledAt: string;
  cpuLoad: number | null;
  cpuCores: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  percentUsedMemory: number | null;
  dockerAvailable: boolean | null;
  dockerInfo: SlimDockerInfo | null;
  apps: TelemetryAppPoint[] | null;
  source: string;
};

export type HostEventRow = {
  createdAt: string;
  level: string;
  source: string;
  message: string;
  details: unknown;
};

type DockerInfoCache = { value: { available: boolean; info: SlimDockerInfo | null }; at: number };

@Injectable()
export class HostTelemetryService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle: NodeJS.Timeout | null = null;
  private dockerInfoCache: DockerInfoCache | null = null;
  private lastDockerAvailable: boolean | null = null;
  private samplesSincePrune = 0;
  private collectInFlight = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    @Inject(SystemService) private readonly systemService: SystemService,
    private readonly logger: LoggerService,
  ) {}

  onModuleInit() {
    void this.recordEvent('info', 'hub.api', 'Hub API started').catch((error) => {
      this.logger.warn(`Host telemetry start event failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    void this.collect('collector');
    this.intervalHandle = setInterval(() => {
      void this.collect('collector');
    }, HOST_TELEMETRY_INTERVAL_MS);
    this.intervalHandle.unref?.();
  }

  async onModuleDestroy() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    await this.collect('shutdown').catch(() => undefined);
    await this.recordEvent('info', 'hub.api', 'Hub API stopping').catch(() => undefined);
  }

  async collect(source = 'collector', apps?: TelemetryAppPoint[]): Promise<void> {
    if (this.collectInFlight && source === 'collector') {
      return;
    }
    this.collectInFlight = true;
    try {
      const sampledAt = new Date().toISOString();
      const [load, docker] = await Promise.all([this.readLoad(), this.readDockerInfo()]);

      if (this.lastDockerAvailable !== null && this.lastDockerAvailable !== docker.available) {
        await this.recordEvent(
          docker.available ? 'info' : 'warn',
          'docker',
          docker.available ? 'Docker daemon became available' : 'Docker daemon became unavailable',
          {
            dockerInfo: docker.info,
          },
        );
      }
      this.lastDockerAvailable = docker.available;

      await this.db.insert(hostTelemetrySample).values({
        sampledAt,
        cpuLoad: load.cpuLoad,
        cpuCores: load.cpuCores,
        memoryUsed: load.memoryUsed,
        memoryTotal: load.memoryTotal,
        diskUsed: load.diskUsed,
        diskTotal: load.diskTotal,
        percentUsedMemory: load.percentUsedMemory,
        dockerAvailable: docker.available,
        dockerInfo: docker.info,
        apps: apps ?? null,
        source,
      });

      this.samplesSincePrune += 1;
      if (this.samplesSincePrune >= PRUNE_EVERY_SAMPLES) {
        this.samplesSincePrune = 0;
        await this.prune();
      }
    } catch (error) {
      this.logger.warn(`Host telemetry sample failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.collectInFlight = false;
    }
  }

  async recordRuntimeApps(sampledAt: string, apps: TelemetryAppPoint[]): Promise<void> {
    try {
      const docker = await this.readDockerInfo();
      const load = await this.readLoad();
      await this.db.insert(hostTelemetrySample).values({
        sampledAt,
        cpuLoad: load.cpuLoad,
        cpuCores: load.cpuCores,
        memoryUsed: load.memoryUsed,
        memoryTotal: load.memoryTotal,
        diskUsed: load.diskUsed,
        diskTotal: load.diskTotal,
        percentUsedMemory: load.percentUsedMemory,
        dockerAvailable: docker.available,
        dockerInfo: docker.info,
        apps,
        source: 'runtime-monitor',
      });
    } catch (error) {
      this.logger.warn(`Host telemetry runtime sample failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async recordEvent(level: string, source: string, message: string, details?: unknown): Promise<void> {
    try {
      await this.db.insert(hostEventLog).values({
        createdAt: new Date().toISOString(),
        level,
        source,
        message,
        details: details ?? null,
      });
    } catch (error) {
      this.logger.warn(`Host event log write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getRecentSamples(limit = 288): Promise<HostTelemetryHistorySample[]> {
    const rows = await this.db.query.hostTelemetrySample.findMany({
      orderBy: (table, { desc }) => [desc(table.sampledAt), desc(table.id)],
      limit: Math.min(Math.max(limit, 1), 2000),
    });
    return rows.reverse().map((row) => this.toHistorySample(row));
  }

  async getRuntimeHistory(limit = 24): Promise<Array<{ sampledAt: string; apps: TelemetryAppPoint[] }>> {
    const rows = await this.getRecentSamples(500);
    const withApps = rows.filter(
      (row): row is HostTelemetryHistorySample & { apps: TelemetryAppPoint[] } => Array.isArray(row.apps) && row.apps.length > 0,
    );
    return withApps.slice(-limit).map((row) => ({ sampledAt: row.sampledAt, apps: row.apps }));
  }

  async getRecentEvents(limit = 200): Promise<HostEventRow[]> {
    const rows = await this.db.query.hostEventLog.findMany({
      orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
      limit: Math.min(Math.max(limit, 1), 1000),
    });
    return rows.map((row) => ({
      createdAt: row.createdAt,
      level: row.level,
      source: row.source,
      message: row.message,
      details: row.details,
    }));
  }

  private toHistorySample(row: typeof hostTelemetrySample.$inferSelect): HostTelemetryHistorySample {
    return {
      sampledAt: row.sampledAt,
      cpuLoad: row.cpuLoad,
      cpuCores: row.cpuCores,
      memoryUsed: row.memoryUsed,
      memoryTotal: row.memoryTotal,
      diskUsed: row.diskUsed,
      diskTotal: row.diskTotal,
      percentUsedMemory: row.percentUsedMemory,
      dockerAvailable: row.dockerAvailable,
      dockerInfo: (row.dockerInfo as SlimDockerInfo | null) ?? null,
      apps: Array.isArray(row.apps) ? (row.apps as TelemetryAppPoint[]) : null,
      source: row.source,
    };
  }

  private async readLoad() {
    try {
      const load = await this.systemService.getSystemLoad();
      return {
        cpuLoad: Math.round(load.cpuLoad ?? 0),
        cpuCores: load.cpuCores ?? null,
        memoryUsed: load.memoryUsed ?? null,
        memoryTotal: load.memoryTotal ?? null,
        diskUsed: load.diskUsed ?? null,
        diskTotal: load.diskSize ?? null,
        percentUsedMemory: load.percentUsedMemory ?? null,
      };
    } catch (error) {
      this.logger.warn(`Host telemetry load probe failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        cpuLoad: null,
        cpuCores: null,
        memoryUsed: null,
        memoryTotal: null,
        diskUsed: null,
        diskTotal: null,
        percentUsedMemory: null,
      };
    }
  }

  async readDockerInfo(): Promise<{ available: boolean; info: SlimDockerInfo | null }> {
    const now = Date.now();
    if (this.dockerInfoCache && now - this.dockerInfoCache.at < DOCKER_INFO_CACHE_MS) {
      return this.dockerInfoCache.value;
    }

    try {
      const info = await this.docker.info();
      const memTotal = typeof info.MemTotal === 'number' ? info.MemTotal : undefined;
      const slim: SlimDockerInfo = {
        ncpu: typeof info.NCPU === 'number' ? info.NCPU : undefined,
        memTotal,
        memTotalMb: memTotal ? Math.floor(memTotal / 1024 / 1024) : undefined,
        containers: typeof info.Containers === 'number' ? info.Containers : undefined,
        containersRunning: typeof info.ContainersRunning === 'number' ? info.ContainersRunning : undefined,
        containersPaused: typeof info.ContainersPaused === 'number' ? info.ContainersPaused : undefined,
        containersStopped: typeof info.ContainersStopped === 'number' ? info.ContainersStopped : undefined,
        images: typeof info.Images === 'number' ? info.Images : undefined,
        serverVersion: typeof info.ServerVersion === 'string' ? info.ServerVersion : undefined,
        driver: typeof info.Driver === 'string' ? info.Driver : undefined,
        operatingSystem: typeof info.OperatingSystem === 'string' ? info.OperatingSystem : undefined,
        name: typeof info.Name === 'string' ? info.Name : undefined,
      };
      const value = { available: true, info: slim };
      this.dockerInfoCache = { value, at: now };
      return value;
    } catch {
      const value = { available: false, info: this.dockerInfoCache?.value.info ?? null };
      this.dockerInfoCache = { value, at: now };
      return value;
    }
  }

  private async prune() {
    const cutoff = new Date(Date.now() - HOST_TELEMETRY_RETENTION_MS).toISOString();
    await this.db.delete(hostTelemetrySample).where(lt(hostTelemetrySample.sampledAt, cutoff));
    await this.db.delete(hostEventLog).where(lt(hostEventLog.createdAt, cutoff));
  }
}
