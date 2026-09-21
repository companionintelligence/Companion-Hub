import { getResourceMonitor, getRuntimeHealth } from '@/api-client/sdk.gen';
import { unwrapSdk } from '@/lib/sdk-unwrap';

export interface AppContainerRuntimeStats {
  containerId: string;
  name: string;
  state: string;
  status: string;
  health: string | null;
  exitCode?: number | null;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
}

export interface AppRuntimeHealth {
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
  /**
   * Real per-process GPU VRAM summed onto this workload's own containers, in MB — see
   * `gpu-process-sampler.service.ts` and `DockerReadFacade.mapPidsToContainers` on the backend.
   * `null`, never `0`: the underlying tools are a presence list, not a per-container gauge, so
   * there is no way to positively confirm "measured and definitely zero". Compute UTILIZATION per
   * workload is not represented anywhere — see `workload-coverage.tsx`.
   */
  gpuVramMb: number | null;
}

export interface AppRuntimeHistoryPoint {
  appUrn: string;
  appName: string;
  status: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  containerCount: number;
  /** Same field, same `null`-means-nothing-found rule, as {@link AppRuntimeHealth.gpuVramMb}. */
  gpuVramMb: number | null;
}

export interface AppRuntimeHistorySample {
  sampledAt: string;
  apps: AppRuntimeHistoryPoint[];
}

/** GPU VRAM this sample found but could not attribute to any tracked workload — a bare host process (Ollama, normally) or an unmanaged container. */
export interface UnattributedGpuProcess {
  processName: string;
  vramMb: number;
}

/**
 * Where a tick's per-process VRAM came from. `host-file` is the probe on the host
 * (`docs/fleet-setup.md`, "Per-process GPU VRAM"); `tool` is `nvidia-smi` / `rocm-smi` run by the Hub
 * itself, which only works outside Docker; `absent` means nothing on this node could answer, so
 * every `gpuVramMb` in the snapshot is `null` for want of a measurement, not for want of a workload.
 */
export type GpuVramSource = 'host-file' | 'tool' | 'absent';

export interface AppRuntimeMonitorSnapshot {
  sampledAt: string;
  apps: AppRuntimeHealth[];
  history: AppRuntimeHistorySample[];
  unattributedGpu: UnattributedGpuProcess[] | null;
  /** `null` only when the backend's collection did not happen at all (its empty snapshot). */
  gpuVramSource: GpuVramSource | null;
}

export async function fetchAppRuntimeHealth(appUrn: string): Promise<AppRuntimeHealth> {
  return unwrapSdk(getRuntimeHealth({ path: { urn: appUrn } } as Parameters<typeof getRuntimeHealth>[0])) as Promise<AppRuntimeHealth>;
}

export async function fetchAppRuntimeMonitor(): Promise<AppRuntimeMonitorSnapshot> {
  return unwrapSdk(getResourceMonitor()) as Promise<AppRuntimeMonitorSnapshot>;
}

export function formatCpuLimitLabel(value: string | null, usesDefaultCpuLimit: boolean): string {
  if (!value) {
    return 'Unlimited';
  }

  return usesDefaultCpuLimit ? `${value} cores (default)` : `${value} cores`;
}
