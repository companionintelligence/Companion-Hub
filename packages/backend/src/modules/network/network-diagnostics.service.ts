import { HUB_CONTAINER_NAMES, HUB_NETWORK_NAMES, hubContainerName } from '@/common/constants';
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

/** An orphan plus the Hub containers still on it, which must leave before Docker removes it. */
type OrphanNetworkCandidate = OrphanNetworkIssue & { hubContainerIds: string[] };

/**
 * Whether a container is the Hub itself. The Hub joins each app's own network so the app's services
 * can reach it (`HubAppNetworkService`), so its endpoint is on networks it does not own.
 */
function isHubContainer(container: { Names?: string[] }): boolean {
  const hubNames = new Set<string>([...HUB_CONTAINER_NAMES, hubContainerName()]);
  return (container.Names ?? []).some((name) => hubNames.has(name.replace(/^\//, '')));
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
    const orphanNetworks = (await this.findOrphanNetworks()).map(({ hubContainerIds: _hub, ...orphan }) => orphan);

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
        for (const hubContainerId of orphan.hubContainerIds) {
          await this.docker
            .getNetwork(orphan.dockerNetworkId)
            .disconnect({ Container: hubContainerId, Force: true })
            .catch((error: unknown) => {
              // The removal below reports what matters if the Hub is in fact still attached.
              this.logger.debug(`Could not take the Hub off orphan network ${orphan.dockerNetworkName}: ${error}`);
            });
        }
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

  /**
   * Compose-project networks no container is on.
   *
   * The Hub's own endpoint does not count on an app's network: the Hub joins every app network it
   * can, so counting it would keep each app network alive forever once the app's containers are
   * gone. It still counts on the networks of the Hub's own compose project.
   */
  private async findOrphanNetworks(): Promise<OrphanNetworkCandidate[]> {
    const networks = await this.docker.listNetworks().catch((error) => {
      this.logger.warn(`Failed to list Docker networks for diagnostics: ${error}`);
      return [];
    });

    const containers = await this.docker.listContainers({ all: true }).catch((error) => {
      this.logger.warn(`Failed to list Docker containers for diagnostics: ${error}`);
      return [];
    });

    const networksInUse = new Set<string>();
    const hubContainersByNetwork = new Map<string, string[]>();
    const hubProjects = new Set<string>();
    for (const container of containers) {
      const isHub = isHubContainer(container);
      const hubProject = isHub ? container.Labels?.['com.docker.compose.project'] : undefined;
      if (hubProject) {
        hubProjects.add(hubProject);
      }
      for (const networkName of Object.keys(container.NetworkSettings?.Networks ?? {})) {
        if (isHub) {
          hubContainersByNetwork.set(networkName, [...(hubContainersByNetwork.get(networkName) ?? []), container.Id]);
        } else {
          networksInUse.add(networkName);
        }
      }
    }

    const orphans: OrphanNetworkCandidate[] = [];

    for (const network of networks) {
      const networkName = network.Name;
      if (!networkName || HUB_NETWORK_NAMES.includes(networkName as (typeof HUB_NETWORK_NAMES)[number])) {
        continue;
      }

      const composeProject = network.Labels?.['com.docker.compose.project'];
      if (!composeProject || composeProject === 'ci-hub' || hubProjects.has(composeProject)) {
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
        hubContainerIds: hubContainersByNetwork.get(networkName) ?? [],
      });
    }

    return orphans;
  }
}
