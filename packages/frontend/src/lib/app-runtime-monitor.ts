import { apiFetch } from './api-fetch';

export interface AppContainerRuntimeStats {
  containerId: string;
  name: string;
  state: string;
  status: string;
  health: string | null;
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

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function fetchAppRuntimeHealth(appUrn: string): Promise<AppRuntimeHealth> {
  const response = await apiFetch(`/api/apps/${encodeURIComponent(appUrn)}/runtime-health`);
  return parseJson<AppRuntimeHealth>(response);
}

export async function fetchAppRuntimeMonitor(): Promise<AppRuntimeMonitorSnapshot> {
  const response = await apiFetch('/api/apps/resource-monitor');
  return parseJson<AppRuntimeMonitorSnapshot>(response);
}

export function formatCpuLimitLabel(value: string | null, usesDefaultCpuLimit: boolean): string {
  if (!value) {
    return 'Unlimited';
  }

  return usesDefaultCpuLimit ? `${value} cores (default)` : `${value} cores`;
}
