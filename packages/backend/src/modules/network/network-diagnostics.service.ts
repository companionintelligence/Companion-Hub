import { DEFAULT_NETWORK_NAME } from '@/common/constants';
import { LoggerService } from '@/core/logger/logger.service';
import { Inject, Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import Dockerode from 'dockerode';
import { AppsRepository } from '../apps/apps.repository';
import { DOCKERODE } from '../docker/constants';
import { cidrOverlaps, normalizeIpv4Cidr } from './cidr-overlap';
import { HUB_APP_POOL_CIDR } from './network-constants';
import { collectOccupiedSubnets, type OccupiedSubnet } from './subnet-occupancy';

export interface DuplicateDbSubnetIssue {
  subnet: string;
  appUrns: AppUrn[];
}

export interface HubPoolOverlapIssue {
  cidr: string;
  conflictsWith: string;
  dockerNetworkId?: string;
  dockerNetworkName?: string;
  composeProject?: string;
  conflictingAppUrn?: AppUrn;
}

export interface OrphanNetworkIssue {
  dockerNetworkId: string;
  dockerNetworkName: string;
  composeProject?: string;
}

export interface NetworkDiagnosticsReport {
  duplicateDbSubnets: DuplicateDbSubnetIssue[];
  hubPoolOverlaps: HubPoolOverlapIssue[];
  orphanNetworks: OrphanNetworkIssue[];
  issueCount: number;
}

export interface NetworkRepairResult {
  removed: string[];
  skipped: string[];
  failed: { networkName: string; message: string }[];
}

@Injectable()
export class NetworkDiagnosticsService {
  constructor(
    private readonly appsRepository: AppsRepository,
    private readonly logger: LoggerService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
  ) {}

  public async getDiagnostics(): Promise<NetworkDiagnosticsReport> {
    const apps = await this.appsRepository.getApps();
    const occupied = await collectOccupiedSubnets(apps, this.docker);
    const duplicateDbSubnets = this.findDuplicateDbSubnets(apps);
    const hubPoolOverlaps = this.findOccupiedRangeConflicts(occupied);
    const orphanNetworks = await this.findOrphanNetworks();

    return {
      duplicateDbSubnets,
      hubPoolOverlaps,
      orphanNetworks,
      issueCount: duplicateDbSubnets.length + hubPoolOverlaps.length + orphanNetworks.length,
    };
  }

  public async reconcileOrphanNetworks(): Promise<{ success: boolean; message: string; removedCount: number }> {
    const repair = await this.repairOrphanNetworks();
    const removedCount = repair.removed.length;

    if (removedCount > 0) {
      this.logger.info(`Reconciled ${removedCount} orphan compose network(s): ${repair.removed.join(', ')}`);
    }

    if (repair.failed.length > 0) {
      return {
        success: false,
        message: `Removed ${removedCount} orphan network(s); ${repair.failed.length} failed`,
        removedCount,
      };
    }

    return {
      success: true,
      message: removedCount > 0 ? `Removed ${removedCount} orphan network(s)` : 'No orphan networks to remove',
      removedCount,
    };
  }

  public async repairOrphanNetworks(): Promise<NetworkRepairResult> {
    const orphans = await this.findOrphanNetworks();
    const removed: string[] = [];
    const skipped: string[] = [];
    const failed: { networkName: string; message: string }[] = [];

    for (const orphan of orphans) {
      try {
        await this.docker.getNetwork(orphan.dockerNetworkId).remove();
        removed.push(orphan.dockerNetworkName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/already in use|has active endpoints|not found/i.test(message)) {
          skipped.push(orphan.dockerNetworkName);
          continue;
        }

        failed.push({ networkName: orphan.dockerNetworkName, message });
      }
    }

    return { removed, skipped, failed };
  }

  private findDuplicateDbSubnets(apps: { appName: string; appStoreSlug: string; subnet: string | null }[]): DuplicateDbSubnetIssue[] {
    const grouped = new Map<string, AppUrn[]>();

    for (const app of apps) {
      if (!app.subnet) {
        continue;
      }

      const normalized = normalizeIpv4Cidr(app.subnet);
      if (!normalized) {
        continue;
      }

      const appUrn = `${app.appName}:${app.appStoreSlug}` as AppUrn;
      const existing = grouped.get(normalized) ?? [];
      existing.push(appUrn);
      grouped.set(normalized, existing);
    }

    return [...grouped.entries()].filter(([, appUrns]) => appUrns.length > 1).map(([subnet, appUrns]) => ({ subnet, appUrns }));
  }

  private findOccupiedRangeConflicts(occupied: OccupiedSubnet[]): HubPoolOverlapIssue[] {
    const conflicts: HubPoolOverlapIssue[] = [];
    const seen = new Set<string>();

    for (const [index, left] of occupied.entries()) {
      if (!cidrOverlaps(left.cidr, HUB_APP_POOL_CIDR)) {
        continue;
      }

      for (const right of occupied.slice(index + 1)) {
        if (!cidrOverlaps(left.cidr, right.cidr)) {
          continue;
        }

        if (this.isSameComposeOwner(left, right)) {
          continue;
        }

        const key = [left.cidr, right.cidr].sort().join('|');
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        const dockerEntry = left.source === 'docker' ? left : right.source === 'docker' ? right : left;
        const otherEntry = dockerEntry === left ? right : left;

        conflicts.push({
          cidr: dockerEntry.cidr,
          conflictsWith: otherEntry.cidr,
          dockerNetworkId: dockerEntry.dockerNetworkId,
          dockerNetworkName: dockerEntry.dockerNetworkName,
          composeProject: dockerEntry.composeProject,
          conflictingAppUrn: otherEntry.appUrn,
        });
      }
    }

    return conflicts;
  }

  private isSameComposeOwner(left: OccupiedSubnet, right: OccupiedSubnet): boolean {
    if (left.composeProject && left.composeProject === right.composeProject) {
      return true;
    }

    if (left.appUrn && right.composeProject) {
      return right.composeProject === left.appUrn.replace(':', '_');
    }

    if (right.appUrn && left.composeProject) {
      return left.composeProject === right.appUrn.replace(':', '_');
    }

    return false;
  }

  private async findOrphanNetworks(): Promise<OrphanNetworkIssue[]> {
    const networks = await this.docker.listNetworks().catch((error) => {
      this.logger.warn(`Failed to list Docker networks for diagnostics: ${error}`);
      return [];
    });

    const containers = await this.docker.listContainers({ all: true }).catch((error) => {
      this.logger.warn(`Failed to list Docker containers for diagnostics: ${error}`);
      return [];
    });

    const networksInUse = new Set<string>();
    for (const container of containers) {
      for (const networkName of Object.keys(container.NetworkSettings?.Networks ?? {})) {
        networksInUse.add(networkName);
      }
    }

    const orphans: OrphanNetworkIssue[] = [];

    for (const network of networks) {
      const networkName = network.Name;
      if (!networkName || networkName === DEFAULT_NETWORK_NAME) {
        continue;
      }

      const composeProject = network.Labels?.['com.docker.compose.project'];
      if (!composeProject || composeProject === 'ci-hub') {
        continue;
      }

      const isExternal = network.Labels?.['com.docker.compose.network.external'] === 'true';
      if (isExternal) {
        continue;
      }

      if (networksInUse.has(networkName)) {
        continue;
      }

      orphans.push({
        dockerNetworkId: network.Id,
        dockerNetworkName: networkName,
        composeProject,
      });
    }

    return orphans;
  }
}
