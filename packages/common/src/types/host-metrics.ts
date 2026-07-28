export type HostPlatform = 'darwin' | 'win32' | 'linux';
export type HostCpuArch = 'arm64' | 'x86_64';
export type HostMetricsSource = 'init-host-probe' | 'desktop-host-macos' | 'desktop-host-windows' | 'desktop-host-linux';
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

export type HostFirewallKind = 'ufw' | 'firewalld' | 'nftables' | 'iptables' | 'none' | 'unknown';

/**
 * Which packet filter is running on the host, recorded by `init-host-probe`.
 *
 * The Hub backend runs inside a container and cannot inspect the host's
 * firewall itself, so it relies on this being captured host-side. Without it
 * the Hub can only guess at the syntax when telling an operator how to unblock
 * the Docker bridge.
 */
export interface HostFirewallInfo {
  kind: HostFirewallKind;
  /** True when the firewall is enabled and enforcing rules. */
  active: boolean;
}

export interface HostMetricsProbeFile {
  schemaVersion: 1;
  platform: HostPlatform;
  cpuArch: HostCpuArch;
  source: HostMetricsSource;
  probedAt: string;
  host: HostMetricsHostSection;
  /** Absent on probes written before firewall detection existed. */
  firewall?: HostFirewallInfo;
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
  platformGuidance?: string;
}
