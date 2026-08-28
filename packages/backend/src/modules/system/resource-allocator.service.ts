import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { Inject, Injectable } from '@nestjs/common';
import type Dockerode from 'dockerode';
import { HostMetricsService } from './host-metrics.service';

const DOCKER_INFO_CACHE_MS = 60_000;
const DOCKER_TUNING_RECORD_PATH = '/data/state/hardware/docker-tuning.json';

// Per-app *recommendation* for the UI / settings. Compose generation must
// not stamp these onto every service (that is a per-container cgroup at
// half the host, N times). Inference (vLLM/Ollama) is outside app compose.
const APP_MEMORY_FRACTION = 0.5;
const APP_CPU_FRACTION = 0.75;
const HUB_STACK_RESERVE_MB = 2048;
const MIN_APP_MEMORY_MB = 1024;
const MIN_RECOMMENDED_DISK_GB = 64;

export interface DockerCapacity {
  cpuCores: number;
  memTotalMb: number;
  serverVersion?: string;
}

export interface AutoAppLimits {
  cpuLimit?: string;
  memoryLimit?: string;
}

@Injectable()
export class ResourceAllocatorService {
  private dockerInfoCache: { value: DockerCapacity | null; expiresAt: number } | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly filesystem: FilesystemService,
    private readonly hostMetrics: HostMetricsService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
  ) {}

  /**
   * Resources as the Docker daemon sees them. On macOS/Windows this is the
   * Docker Desktop VM allocation, not the host — which is exactly the budget
   * containers can actually use.
   */
  public async getDockerCapacity(): Promise<DockerCapacity | null> {
    const now = Date.now();
    if (this.dockerInfoCache && this.dockerInfoCache.expiresAt > now) {
      return this.dockerInfoCache.value;
    }

    let capacity: DockerCapacity | null = null;
    try {
      const info = await this.docker.info();
      const cpuCores = typeof info.NCPU === 'number' ? info.NCPU : 0;
      const memTotalMb = typeof info.MemTotal === 'number' ? Math.floor(info.MemTotal / 1024 / 1024) : 0;
      if (cpuCores > 0 && memTotalMb > 0) {
        capacity = { cpuCores, memTotalMb, serverVersion: typeof info.ServerVersion === 'string' ? info.ServerVersion : undefined };
      }
    } catch (error) {
      this.logger.warn(`Could not read Docker daemon capacity: ${error}`);
    }

    this.dockerInfoCache = { value: capacity, expiresAt: now + DOCKER_INFO_CACHE_MS };
    return capacity;
  }

  /**
   * Per-app default resource caps derived from what Docker actually has.
   * Used when neither the install form nor the user settings specify a limit.
   */
  public async getAutoAppLimits(): Promise<AutoAppLimits> {
    const capacity = await this.getDockerCapacity();
    if (!capacity) {
      return {};
    }

    const cpuTarget = Math.max(1, Math.round(capacity.cpuCores * APP_CPU_FRACTION * 100) / 100);
    const cpuLimit = String(cpuTarget);

    const memoryCeiling = Math.max(MIN_APP_MEMORY_MB, capacity.memTotalMb - HUB_STACK_RESERVE_MB);
    const memoryTarget = Math.min(memoryCeiling, Math.max(MIN_APP_MEMORY_MB, Math.floor(capacity.memTotalMb * APP_MEMORY_FRACTION)));
    const memoryLimit = `${memoryTarget}M`;

    return { cpuLimit, memoryLimit };
  }

  /**
   * Effective per-app default limits after applying precedence:
   * user settings override auto-computed values; auto allocation can be
   * disabled entirely via the autoAllocateAppResources setting.
   */
  public async getEffectiveAppDefaults(): Promise<AutoAppLimits & { autoAllocated: boolean }> {
    const userSettings = this.config.get('userSettings') as Record<string, unknown>;
    const settingsCpuLimit = typeof userSettings.defaultAppCpuLimit === 'string' ? userSettings.defaultAppCpuLimit.trim() || undefined : undefined;
    const settingsMemoryLimit =
      typeof userSettings.defaultAppMemoryLimit === 'string' ? userSettings.defaultAppMemoryLimit.trim() || undefined : undefined;
    const autoAllocate = userSettings.autoAllocateAppResources !== false;

    if (!autoAllocate || (settingsCpuLimit && settingsMemoryLimit)) {
      return { cpuLimit: settingsCpuLimit, memoryLimit: settingsMemoryLimit, autoAllocated: false };
    }

    const auto = await this.getAutoAppLimits();
    return {
      cpuLimit: settingsCpuLimit || auto.cpuLimit,
      memoryLimit: settingsMemoryLimit || auto.memoryLimit,
      autoAllocated: Boolean((!settingsCpuLimit && auto.cpuLimit) || (!settingsMemoryLimit && auto.memoryLimit)),
    };
  }

  /**
   * Full picture for the UI / desktop app: what Docker has, what the host has,
   * what Docker should be given (VM sizing), the per-app defaults in effect,
   * and the outcome of the desktop's last VM tuning attempt.
   */
  public async getResourceOverview() {
    const [capacity, hostProbe, appDefaults] = await Promise.all([
      this.getDockerCapacity(),
      this.hostMetrics.readHostProbe(),
      this.getEffectiveAppDefaults(),
    ]);

    const host = hostProbe?.host ?? null;
    const runtimeKind = this.hostMetrics.detectRuntimeKind(hostProbe);
    const hasVmWedge = capacity ? this.hostMetrics.detectVmWedge(hostProbe, { totalRamMb: capacity.memTotalMb }) : false;

    let recommended: { dockerRamMb: number; dockerCpus: number; dockerDiskGb: number } | null = null;
    if (host) {
      recommended = {
        dockerRamMb: this.hostMetrics.recommendedDockerRamMb(host.totalRamMb),
        dockerCpus: host.cpuCores > 0 ? host.cpuCores : (capacity?.cpuCores ?? 0),
        dockerDiskGb: host.diskTotalGb > 0 ? Math.max(MIN_RECOMMENDED_DISK_GB, Math.floor(host.diskTotalGb / 2)) : MIN_RECOMMENDED_DISK_GB,
      };
    }

    return {
      docker: capacity,
      host: host
        ? {
            cpuCores: host.cpuCores,
            totalRamMb: host.totalRamMb,
            availableRamMb: host.availableRamMb,
            diskTotalGb: host.diskTotalGb,
            diskUsedGb: host.diskUsedGb,
          }
        : null,
      runtimeKind,
      hasVmWedge,
      recommended,
      appDefaults,
      tuning: await this.readTuningRecord(),
    };
  }

  private async readTuningRecord(): Promise<Record<string, unknown> | null> {
    try {
      const raw = await this.filesystem.readTextFile(DOCKER_TUNING_RECORD_PATH);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
