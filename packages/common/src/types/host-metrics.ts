export type HostPlatform = 'darwin' | 'win32' | 'linux';
export type HostCpuArch = 'arm64' | 'x86_64';
export type HostMetricsSource = 'init-host-probe' | 'desktop-host-macos' | 'desktop-host-windows';
export type RuntimeKind = 'container-only' | 'docker-desktop-vm' | 'wsl2-vm' | 'linux-native' | 'host-native';

export interface HostMetricsHostSection {
  totalRamMb: number;
  availableRamMb: number;
  cpuCores: number;
  cpuModel?: string;
  diskTotalGb: number;
  diskUsedGb: number;
  diskMount: string;
}

export interface HostMetricsContainerSection {
  totalRamMb: number;
  availableRamMb: number;
  diskTotalGb: number;
  diskUsedGb: number;
}

export interface HostMetricsProbeFile {
  schemaVersion: 1;
  platform: HostPlatform;
  cpuArch: HostCpuArch;
  source: HostMetricsSource;
  probedAt: string;
  host: HostMetricsHostSection;
}

export interface HostMetricsDisplayLoad {
  diskUsed: number;
  diskSize: number;
  percentUsed: number;
  cpuLoad: number;
  cpuCores: number;
  memoryTotal: number;
  percentUsedMemory: number;
  memoryUsed: number;
  hasVmWedge: boolean;
  runtimeKind: RuntimeKind;
  containerMemoryTotal?: number;
  containerMemoryUsed?: number;
  containerDiskTotal?: number;
  containerDiskUsed?: number;
  recommendedDockerRamMb?: number;
}
