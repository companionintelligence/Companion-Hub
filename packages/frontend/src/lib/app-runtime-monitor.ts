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
}

export interface AppRuntimeHistoryPoint {
  appUrn: string;
  appName: string;
  status: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  containerCount: number;
}

export interface AppRuntimeHistorySample {
  sampledAt: string;
  apps: AppRuntimeHistoryPoint[];
}

export interface AppRuntimeMonitorSnapshot {
  sampledAt: string;
  apps: AppRuntimeHealth[];
  history: AppRuntimeHistorySample[];
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
