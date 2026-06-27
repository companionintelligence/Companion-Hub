import type { HubEnv } from './cihub-cli';
import { hubApiFetch } from './public-web-cli';

export interface NetworkDiagnosticsReport {
  duplicateDbSubnets: { subnet: string; appUrns: string[] }[];
  hubPoolOverlaps: {
    cidr: string;
    conflictsWith: string;
    dockerNetworkId?: string;
    dockerNetworkName?: string;
    composeProject?: string;
    conflictingAppUrn?: string;
  }[];
  orphanNetworks: {
    dockerNetworkId: string;
    dockerNetworkName: string;
    composeProject?: string;
  }[];
  issueCount: number;
}

export interface NetworkRepairResponse {
  removed: string[];
  skipped: string[];
  failed: { networkName: string; message: string }[];
}

export function formatNetworkDiagnosticsLines(report: NetworkDiagnosticsReport): string[] {
  const lines: string[] = [];

  if (report.duplicateDbSubnets.length === 0) {
    lines.push('Duplicate DB subnets     ok');
  } else {
    lines.push(`Duplicate DB subnets     ${report.duplicateDbSubnets.length} conflict(s)`);
    for (const issue of report.duplicateDbSubnets) {
      lines.push(`  ${issue.subnet} -> ${issue.appUrns.join(', ')}`);
    }
  }

  if (report.hubPoolOverlaps.length === 0) {
    lines.push('Hub pool overlaps        ok');
  } else {
    lines.push(`Hub pool overlaps        ${report.hubPoolOverlaps.length} conflict(s)`);
    for (const issue of report.hubPoolOverlaps.slice(0, 5)) {
      const label = issue.dockerNetworkName ?? issue.cidr;
      lines.push(`  ${label} (${issue.cidr}) overlaps ${issue.conflictsWith}`);
    }
    if (report.hubPoolOverlaps.length > 5) {
      lines.push(`  ... and ${report.hubPoolOverlaps.length - 5} more`);
    }
  }

  if (report.orphanNetworks.length === 0) {
    lines.push('Orphan compose networks  ok');
  } else {
    lines.push(`Orphan compose networks  ${report.orphanNetworks.length} unused bridge(s)`);
    for (const issue of report.orphanNetworks.slice(0, 5)) {
      lines.push(`  ${issue.dockerNetworkName}${issue.composeProject ? ` (${issue.composeProject})` : ''}`);
    }
    if (report.orphanNetworks.length > 5) {
      lines.push(`  ... and ${report.orphanNetworks.length - 5} more`);
    }
  }

  return lines;
}

export async function fetchNetworkDiagnostics(envFileName: string): Promise<NetworkDiagnosticsReport> {
  return hubApiFetch<NetworkDiagnosticsReport>(envFileName, '/network/diagnostics');
}

export async function repairOrphanNetworks(envFileName: string): Promise<NetworkRepairResponse> {
  return hubApiFetch<NetworkRepairResponse>(envFileName, '/network/repair-orphans', { method: 'POST', body: '{}' });
}

export async function runNetworkDoctorSection(
  envFileName: string,
  options?: { repairNetworks?: boolean },
): Promise<{ lines: string[]; issueCount: number; repaired?: NetworkRepairResponse }> {
  try {
    const report = await fetchNetworkDiagnostics(envFileName);
    const lines = formatNetworkDiagnosticsLines(report);

    if (options?.repairNetworks && report.orphanNetworks.length > 0) {
      const repaired = await repairOrphanNetworks(envFileName);
      lines.push(`Repair orphans           removed ${repaired.removed.length}, skipped ${repaired.skipped.length}, failed ${repaired.failed.length}`);
      return { lines, issueCount: report.issueCount, repaired };
    }

    return { lines, issueCount: report.issueCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      lines: [`Network diagnostics      unavailable (${message})`],
      issueCount: 0,
    };
  }
}

export function resolveEnvFileName(env: HubEnv): string {
  const envFileMap: Record<HubEnv, string> = {
    local: '.env.local',
    dev: '.env.dev',
    staging: '.env.staging',
    prod: '.env.prod',
  };
  return envFileMap[env];
}
