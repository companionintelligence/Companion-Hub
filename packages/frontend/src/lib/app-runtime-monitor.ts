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

export type AppReadinessStatus = 'ok' | 'degraded' | 'unknown';

export interface AppReadinessCheck {
  /** The app's own vocabulary (`ok`, `degraded`, `unavailable`, ...); only `ok` reads as fine. */
  status: string;
  detail?: string;
}

/**
 * What an app's own readiness endpoint said (`hub_integration.readiness`) — mirrors the backend
 * `AppReadiness` in `app-readiness.helpers.ts`. A second axis next to app status, never an input
 * to it. `unknown` covers every way the Hub can fail to know (timeout, non-2xx, unreadable body)
 * and is deliberately never `degraded`: a single missed probe on a cold gateway is not a broken app.
 */
export interface AppReadiness {
  status: AppReadinessStatus;
  /** Per-subsystem checks by name, as the app reports them; empty when the body had none. */
  checks: Record<string, AppReadinessCheck>;
  /** A turn is in flight; `null` when the app does not say. */
  busy: boolean | null;
  /** Safe to restart right now; `null` when the app does not say. */
  drainable: boolean | null;
  sampledAt: string;
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
  /**
   * `null` when the app declares no readiness endpoint, or is not `running` so nothing was
   * probed — the badge is hidden, not "unknown". See {@link AppReadiness}.
   */
  readiness: AppReadiness | null;
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
