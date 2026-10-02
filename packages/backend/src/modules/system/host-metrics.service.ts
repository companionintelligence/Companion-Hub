import { Injectable } from '@nestjs/common';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import type {
  HostMetricsContainerSection,
  HostMetricsDisplayLoad,
  HostMetricsHostSection,
  HostMetricsProbeFile,
  RuntimeKind,
} from '@ci-hub/common/types';
import si from 'systeminformation';
import { getVmResourceGuidance } from './host-metrics-guidance';

const HOST_METRICS_PATH = '/data/state/hardware/host_metrics.json';
const LEGACY_HOST_SYSTEM_PATH = '/data/state/hardware/host_system.json';
const VM_WEDGE_RATIO = 1.25;
/**
 * A Linux host probe is written once, before the containers start. RAM is read live from
 * meminfo; disk is not. Stat the filesystem at most this often and store the sample back
 * into the probe so the dashboard, model budget, and the next boot all see the same number.
 * macOS and Windows probes stay untouched: inside Docker Desktop the container disk is the
 * VM, not the host.
 */
const LINUX_DISK_REFRESH_MS = 4 * 60 * 60 * 1000;
const OS_RESERVE_MB = 4096;
const MIN_DOCKER_RAM_MB = 8192;
const HOST_RAM_FRACTION = 0.75;

interface LegacyMacHostProbe {
  platform?: string;
  cpuArch?: string;
  cpuModel?: string;
  cpuCores?: number;
  totalRamMb?: number;
  availableRamMb?: number;
  diskTotalGb?: number;
  diskUsedGb?: number;
  diskMount?: string;
}

@Injectable()
export class HostMetricsService {
  /** Last Linux disk sample kept in memory so a failed write does not stat on every poll. */
  private linuxDiskMemo: { at: number; probe: HostMetricsProbeFile } | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly filesystem: FilesystemService,
  ) {}

  async getDisplayLoad(cpuLoad: number, cpuCoresFromSi: number): Promise<HostMetricsDisplayLoad> {
    const [hostProbe, container] = await Promise.all([this.loadHostProbe(), this.readContainerMetrics()]);
    const runtimeKind = this.detectRuntimeKind(hostProbe);
    const hasVmWedge = this.detectVmWedge(hostProbe, container);

    const host = hostProbe?.host ? await this.enrichHostDisk(hostProbe.host, hostProbe.platform) : undefined;
    const memoryTotalGb = host ? Math.round(host.totalRamMb / 1024) : container.memoryTotalGb;
    const memoryUsedGb = host ? Math.round((host.totalRamMb - host.availableRamMb) / 1024) : container.memoryUsedGb;
    const percentUsedMemory =
      host && host.totalRamMb > 0 ? Math.round(((host.totalRamMb - host.availableRamMb) / host.totalRamMb) * 100) : container.memoryPercentUsed;

    const useHostDisk = Boolean(host && host.diskTotalGb > 0);
    const diskSize = useHostDisk && host ? host.diskTotalGb : hasVmWedge ? 0 : container.diskTotalGb;
    const diskUsed = useHostDisk && host ? host.diskUsedGb : hasVmWedge ? 0 : container.diskUsedGb;
    const percentUsed = diskSize > 0 ? Math.round((diskUsed / diskSize) * 100) : 0;

    const cpuCores = host?.cpuCores && host.cpuCores > 0 ? host.cpuCores : cpuCoresFromSi;

    const display: HostMetricsDisplayLoad = {
      diskUsed,
      diskSize,
      percentUsed,
      cpuLoad,
      cpuCores,
      memoryTotal: memoryTotalGb,
      memoryUsed: memoryUsedGb,
      percentUsedMemory,
      hasVmWedge,
      runtimeKind,
    };

    if (hostProbe) {
      display.platformGuidance = getVmResourceGuidance(runtimeKind, hostProbe.platform, {
        hasVmWedge,
      });
    }

    if (hasVmWedge) {
      display.containerMemoryTotal = container.memoryTotalGb;
      display.containerMemoryUsed = container.memoryUsedGb;
      display.containerDiskTotal = container.diskTotalGb;
      display.containerDiskUsed = container.diskUsedGb;
      if (host) {
        display.recommendedDockerRamMb = this.recommendedDockerRamMb(host.totalRamMb);
      }
    }

    return display;
  }

  async readHostSection(): Promise<HostMetricsHostSection | null> {
    const probe = await this.readHostProbe();
    return probe?.host ?? null;
  }

  async readHostProbe(): Promise<HostMetricsProbeFile | null> {
    return this.loadHostProbe();
  }

  recommendedDockerRamMb(hostRamMb: number): number {
    if (hostRamMb <= 0) return MIN_DOCKER_RAM_MB;
    const capped = Math.floor(hostRamMb * HOST_RAM_FRACTION);
    const reserved = Math.max(0, hostRamMb - OS_RESERVE_MB);
    return Math.max(MIN_DOCKER_RAM_MB, Math.min(capped, reserved, hostRamMb));
  }

  detectRuntimeKind(hostProbe: HostMetricsProbeFile | null): RuntimeKind {
    if (!hostProbe?.host?.totalRamMb) {
      if (process.env.NODE_ENV === 'development' && !process.env.CI_HUB_IN_DOCKER) {
        return 'host-native';
      }
      return 'container-only';
    }

    if (hostProbe.platform === 'linux') {
      return 'linux-native';
    }
    if (hostProbe.platform === 'win32') {
      return 'wsl2-vm';
    }
    if (hostProbe.platform === 'darwin') {
      return 'docker-desktop-vm';
    }

    if (process.env.NODE_ENV === 'development') {
      return 'host-native';
    }

    return 'container-only';
  }

  detectVmWedge(hostProbe: HostMetricsProbeFile | null, container: Pick<HostMetricsContainerSection, 'totalRamMb'>): boolean {
    const hostRamMb = hostProbe?.host?.totalRamMb;
    const containerRamMb = container.totalRamMb;
    if (!hostRamMb || containerRamMb <= 0) {
      return false;
    }
    return hostRamMb > containerRamMb * VM_WEDGE_RATIO;
  }

  private async loadHostProbe(): Promise<HostMetricsProbeFile | null> {
    const metrics = await this.readProbeFile(HOST_METRICS_PATH);
    if (metrics) {
      const current = await this.refreshLinuxDiskIfDue(metrics);
      return {
        ...current,
        host: await this.enrichHostDisk(current.host, current.platform),
      };
    }

    return this.readLegacyMacProbe();
  }

  /**
   * Replace a Linux probe's disk fields from a live stat when the stored sample is older
   * than four hours. One `fsSize` call, then the same JSON the boot probe already uses.
   */
  private async refreshLinuxDiskIfDue(probe: HostMetricsProbeFile): Promise<HostMetricsProbeFile> {
    if (probe.platform !== 'linux') {
      return probe;
    }

    const now = Date.now();
    if (this.linuxDiskMemo && now - this.linuxDiskMemo.at < LINUX_DISK_REFRESH_MS) {
      return this.linuxDiskMemo.probe;
    }

    const probedAtMs = Date.parse(probe.probedAt);
    const sampleIsFresh = Number.isFinite(probedAtMs) && now - probedAtMs < LINUX_DISK_REFRESH_MS && probe.host.diskTotalGb > 0;
    if (sampleIsFresh) {
      this.linuxDiskMemo = { at: probedAtMs, probe };
      return probe;
    }

    const live = await this.readLiveDisk(probe.host.diskMount);
    if (!live) {
      this.linuxDiskMemo = { at: now, probe };
      return probe;
    }

    const next: HostMetricsProbeFile = {
      ...probe,
      probedAt: new Date(now).toISOString(),
      host: {
        ...probe.host,
        diskTotalGb: live.diskTotalGb,
        diskUsedGb: live.diskUsedGb,
        diskMount: live.diskMount || probe.host.diskMount,
      },
    };
    const wrote = await this.filesystem.writeJsonFile(HOST_METRICS_PATH, next);
    if (wrote) {
      this.logger.info(`Refreshed Linux disk sample: ${live.diskUsedGb}/${live.diskTotalGb} GB on ${next.host.diskMount}`);
    } else {
      this.logger.warn('Could not store the refreshed Linux disk sample; this process will keep it until the next check');
    }
    this.linuxDiskMemo = { at: now, probe: next };
    return next;
  }

  private async readLiveDisk(mount: string): Promise<{ diskTotalGb: number; diskUsedGb: number; diskMount: string } | null> {
    const entries = await this.listFilesystems();
    const wanted = mount || '/';
    const match = entries.find((entry) => entry.mount === wanted) ?? entries.find((entry) => entry.mount === '/') ?? entries[0];
    if (!match?.size) {
      return null;
    }
    const diskTotalGb = Math.round(match.size / 1024 / 1024 / 1024);
    const diskFreeGb = Math.round(match.available / 1024 / 1024 / 1024);
    if (diskTotalGb <= 0) {
      return null;
    }
    return {
      diskTotalGb,
      diskUsedGb: Math.max(0, diskTotalGb - diskFreeGb),
      diskMount: match.mount || wanted,
    };
  }

  /**
   * Callers that mock systeminformation leave `fsSize` returning undefined. That is not a
   * reading, and neither is a thrown stat. An empty list keeps the stored sample.
   */
  private async listFilesystems(): Promise<Awaited<ReturnType<typeof si.fsSize>>> {
    try {
      const result = await si.fsSize();
      if (Array.isArray(result)) {
        return result;
      }
    } catch {
      return [];
    }
    return [];
  }

  private async readProbeFile(filePath: string): Promise<HostMetricsProbeFile | null> {
    try {
      const raw = await this.filesystem.readTextFile(filePath);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<HostMetricsProbeFile>;
      if (parsed.schemaVersion !== 1) return null;
      if (!parsed.host || typeof parsed.host.totalRamMb !== 'number' || parsed.host.totalRamMb <= 0) {
        return null;
      }
      return parsed as HostMetricsProbeFile;
    } catch {
      return null;
    }
  }

  private async readLegacyMacProbe(): Promise<HostMetricsProbeFile | null> {
    try {
      const raw = await this.filesystem.readTextFile(LEGACY_HOST_SYSTEM_PATH);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as LegacyMacHostProbe;
      if (parsed.platform !== 'darwin' || typeof parsed.totalRamMb !== 'number' || parsed.totalRamMb <= 0) {
        return null;
      }
      const legacyDisk = await this.readLegacyMacDiskFields();
      return {
        schemaVersion: 1,
        platform: 'darwin',
        cpuArch: parsed.cpuArch === 'arm64' ? 'arm64' : 'x86_64',
        source: 'desktop-host-macos',
        probedAt: new Date().toISOString(),
        host: {
          totalRamMb: parsed.totalRamMb,
          availableRamMb:
            typeof parsed.availableRamMb === 'number' && parsed.availableRamMb > 0
              ? Math.min(parsed.availableRamMb, parsed.totalRamMb)
              : Math.round(parsed.totalRamMb * 0.85),
          cpuCores: typeof parsed.cpuCores === 'number' && parsed.cpuCores > 0 ? parsed.cpuCores : 0,
          cpuModel: typeof parsed.cpuModel === 'string' ? parsed.cpuModel : undefined,
          diskTotalGb: legacyDisk?.diskTotalGb ?? 0,
          diskUsedGb: legacyDisk?.diskUsedGb ?? 0,
          diskMount: legacyDisk?.diskMount ?? '/',
        },
      };
    } catch {
      return null;
    }
  }

  private isStaleDarwinRootDiskProbe(host: HostMetricsHostSection, platform?: string): boolean {
    if (platform !== 'darwin' || host.diskTotalGb <= 0) return false;
    if (host.diskMount !== '/') return false;
    return host.diskUsedGb / host.diskTotalGb < 0.25;
  }

  private async enrichHostDisk(host: HostMetricsHostSection, platform?: string): Promise<HostMetricsHostSection> {
    if (host.diskTotalGb > 0 && !this.isStaleDarwinRootDiskProbe(host, platform)) {
      return host;
    }

    const legacyDisk = await this.readLegacyMacDiskFields();
    if (legacyDisk) {
      return { ...host, ...legacyDisk };
    }

    const metricsDisk = await this.readProbeDiskFields(HOST_METRICS_PATH);
    if (metricsDisk) {
      return { ...host, ...metricsDisk };
    }

    return host;
  }

  private async readLegacyMacDiskFields(): Promise<Pick<HostMetricsHostSection, 'diskTotalGb' | 'diskUsedGb' | 'diskMount'> | null> {
    try {
      const raw = await this.filesystem.readTextFile(LEGACY_HOST_SYSTEM_PATH);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as LegacyMacHostProbe;
      if (typeof parsed.diskTotalGb !== 'number' || parsed.diskTotalGb <= 0) return null;
      return {
        diskTotalGb: parsed.diskTotalGb,
        diskUsedGb: typeof parsed.diskUsedGb === 'number' && parsed.diskUsedGb >= 0 ? parsed.diskUsedGb : 0,
        diskMount: typeof parsed.diskMount === 'string' ? parsed.diskMount : '/',
      };
    } catch {
      return null;
    }
  }

  private async readProbeDiskFields(filePath: string): Promise<Pick<HostMetricsHostSection, 'diskTotalGb' | 'diskUsedGb' | 'diskMount'> | null> {
    try {
      const raw = await this.filesystem.readTextFile(filePath);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { host?: Partial<HostMetricsHostSection> };
      const diskTotalGb = parsed.host?.diskTotalGb;
      if (typeof diskTotalGb !== 'number' || diskTotalGb <= 0) return null;
      return {
        diskTotalGb,
        diskUsedGb: typeof parsed.host?.diskUsedGb === 'number' && parsed.host.diskUsedGb >= 0 ? parsed.host.diskUsedGb : 0,
        diskMount: typeof parsed.host?.diskMount === 'string' ? parsed.host.diskMount : '/',
      };
    } catch {
      return null;
    }
  }

  private async readContainerMetrics(): Promise<
    HostMetricsContainerSection & {
      memoryTotalGb: number;
      memoryUsedGb: number;
      memoryPercentUsed: number;
      diskTotalGb: number;
      diskUsedGb: number;
    }
  > {
    const memResult = { totalMb: 0, availableMb: 0 };
    const memInfo = await this.filesystem.readTextFile('/host/proc/meminfo');
    if (memInfo) {
      memResult.totalMb = Math.floor(Number(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0) / 1024);
      memResult.availableMb = Math.floor(Number(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) / 1024);
    }

    if (!memResult.totalMb) {
      try {
        const mem = await si.mem();
        memResult.totalMb = Math.floor(mem.total / 1024 / 1024);
        memResult.availableMb = Math.floor(mem.available / 1024 / 1024);
      } catch (error) {
        this.logger.error(`Unable to read container memory info: ${error}`);
      }
    }

    const [disk0] = await this.listFilesystems();
    const diskTotalGb = disk0 ? Math.round(disk0.size / 1024 / 1024 / 1024) : 0;
    const diskFreeGb = disk0 ? Math.round(disk0.available / 1024 / 1024 / 1024) : 0;
    const diskUsedGb = Math.max(0, diskTotalGb - diskFreeGb);
    const memoryTotalGb = Math.round(memResult.totalMb / 1024) || 0;
    const memoryUsedGb = Math.max(0, Math.round((memResult.totalMb - memResult.availableMb) / 1024));
    const memoryPercentUsed = memResult.totalMb > 0 ? Math.round(((memResult.totalMb - memResult.availableMb) / memResult.totalMb) * 100) : 0;

    return {
      totalRamMb: memResult.totalMb,
      availableRamMb: memResult.availableMb,
      diskTotalGb,
      diskUsedGb,
      memoryTotalGb,
      memoryUsedGb,
      memoryPercentUsed,
    };
  }
}
