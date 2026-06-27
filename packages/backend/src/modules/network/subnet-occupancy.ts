import type { AppUrn } from '@ci-hub/common/types';
import type Dockerode from 'dockerode';
import { normalizeIpv4Cidr } from './cidr-overlap';

export type SubnetOccupancySource = 'database' | 'docker';

export interface OccupiedSubnet {
  cidr: string;
  source: SubnetOccupancySource;
  appUrn?: AppUrn;
  dockerNetworkId?: string;
  dockerNetworkName?: string;
  composeProject?: string;
}

interface AppSubnetRecord {
  appName: string;
  appStoreSlug: string;
  subnet: string | null;
}

function appendUniqueOccupied(occupied: OccupiedSubnet[], seen: Set<string>, entry: OccupiedSubnet): void {
  if (seen.has(entry.cidr)) {
    return;
  }
  seen.add(entry.cidr);
  occupied.push(entry);
}

interface DockerIpamConfig {
  Subnet?: string;
  IPRange?: string;
}

function collectDockerIpamValues(config: DockerIpamConfig): string[] {
  const values: string[] = [];
  if (config.Subnet) {
    values.push(config.Subnet);
  }
  if (config.IPRange) {
    values.push(config.IPRange);
  }
  return values;
}

/**
 * Unified view of IPv4 ranges already in use on the host.
 * DB subnets (excluding optional app) plus live Docker network IPAM entries.
 */
export async function collectOccupiedSubnets(
  apps: AppSubnetRecord[],
  docker: Dockerode,
  options?: { excludeAppUrn?: AppUrn },
): Promise<OccupiedSubnet[]> {
  const occupied: OccupiedSubnet[] = [];
  const seen = new Set<string>();

  for (const record of apps) {
    const recordUrn = `${record.appName}:${record.appStoreSlug}` as AppUrn;
    if (options?.excludeAppUrn && recordUrn === options.excludeAppUrn) {
      continue;
    }
    if (!record.subnet) {
      continue;
    }

    const normalized = normalizeIpv4Cidr(record.subnet);
    if (!normalized) {
      continue;
    }

    appendUniqueOccupied(occupied, seen, {
      cidr: normalized,
      source: 'database',
      appUrn: recordUrn,
    });
  }

  const networks = await docker.listNetworks();
  for (const network of networks ?? []) {
    for (const config of network.IPAM?.Config ?? []) {
      for (const raw of collectDockerIpamValues(config)) {
        const normalized = normalizeIpv4Cidr(raw);
        if (!normalized) {
          continue;
        }

        appendUniqueOccupied(occupied, seen, {
          cidr: normalized,
          source: 'docker',
          dockerNetworkId: network.Id,
          dockerNetworkName: network.Name,
          composeProject: network.Labels?.['com.docker.compose.project'],
        });
      }
    }
  }

  return occupied;
}

export function occupiedCidrStrings(occupied: OccupiedSubnet[]): string[] {
  return occupied.map((entry) => entry.cidr);
}
