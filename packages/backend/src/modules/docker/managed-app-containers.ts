export interface ManagedAppContainerSummary {
  total: number;
  running: number;
  exitZero: number;
}

export type ManagedAppContainerAppStatus = 'running' | 'stopped' | 'missing';

export function summarizeManagedAppContainers(containers: Array<{ State?: string; Status?: string }>): ManagedAppContainerSummary {
  const summary: ManagedAppContainerSummary = { total: containers.length, running: 0, exitZero: 0 };

  for (const container of containers) {
    if (container.State === 'running') {
      summary.running++;
    }
    if (container.State === 'exited' && /Exited \(0\)/.test(container.Status ?? '')) {
      summary.exitZero++;
    }
  }

  return summary;
}

/** Mirrors app-status-sync.service.ts container → app status mapping. */
export function managedAppStatusFromSummary(summary: ManagedAppContainerSummary): ManagedAppContainerAppStatus {
  if (summary.total === 0) {
    return 'missing';
  }
  if (summary.running + summary.exitZero === summary.total) {
    return 'running';
  }
  return 'stopped';
}
