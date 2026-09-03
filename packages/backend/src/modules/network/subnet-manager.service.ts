import { TranslatableError } from '@/common/error/translatable-error';
import { LoggerService } from '@/core/logger/logger.service';
import { Inject, Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import Dockerode from 'dockerode';
import { AppsRepository } from '../apps/apps.repository';
import { DOCKERODE } from '../docker/constants';
import { cidrOverlaps, normalizeIpv4Cidr, parseIpv4Cidr, hubManagedOctetPairsOverlappingRange } from './cidr-overlap';
import { collectOccupiedSubnets, occupiedCidrStrings, type OccupiedSubnet } from './subnet-occupancy';

const SUBNET_MASK = '/24';
const MAX_RETRIES = 3;
const STARTING_OCTET_2 = 128;
const MAX_OCTET_VALUE = 254;
const RESERVED_SUBNET_MAX_OCTET_3 = 9;
const HUB_SUBNET_REGEX = /^10\.(\d{1,3})\.(\d{1,3})\.0\/24$/;

@Injectable()
export class SubnetManagerService {
  constructor(
    private readonly appsRepository: AppsRepository,
    private readonly logger: LoggerService,
    @Inject(DOCKERODE) private docker: Dockerode,
  ) {}

  /**
   * Allocate a subnet for an app
   * @param appUrn The URN of the app to allocate a subnet for
   * @returns The allocated subnet with mask (e.g., 10.128.10.0/24)
   */
  public async allocateSubnet(appUrn: AppUrn, retryCount = 0, excludeSubnets: string[] = []): Promise<string> {
    const existingApp = await this.appsRepository.getAppByUrn(appUrn);

    if (!existingApp) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND');
    }

    if (existingApp.subnet) {
      const normalizedSubnet = normalizeIpv4Cidr(existingApp.subnet) ?? existingApp.subnet;
      const available = await this.isSubnetAvailable(normalizedSubnet, appUrn);
      if (available) {
        if (normalizedSubnet !== existingApp.subnet) {
          await this.appsRepository.updateAppById(existingApp.id, { subnet: normalizedSubnet });
        }
        this.logger.info(`App ${appUrn} already has subnet ${normalizedSubnet}`);
        return normalizedSubnet;
      }

      this.logger.warn(`App ${appUrn} subnet ${existingApp.subnet} conflicts with occupied ranges; reassigning`);
      await this.appsRepository.updateAppById(existingApp.id, { subnet: null });
    }

    const occupied = await this.listOccupiedSubnets(appUrn);
    const nextSubnet = this.findNextAvailableSubnet(occupied, excludeSubnets);

    if (!nextSubnet) {
      throw new TranslatableError('NETWORK_ERROR_NO_AVAILABLE_SUBNETS');
    }

    try {
      await this.appsRepository.updateAppById(existingApp.id, { subnet: nextSubnet });
    } catch (error) {
      if (error instanceof Error && retryCount < MAX_RETRIES) {
        this.logger.error(`Subnet ${nextSubnet} failed to be allocated, retrying...`);
        return this.allocateSubnet(appUrn, retryCount + 1, excludeSubnets);
      }
      throw error;
    }

    this.logger.info(`Allocated subnet ${nextSubnet} for app ${appUrn}`);
    return nextSubnet;
  }

  /** Clear the stored subnet so the next allocate call picks a fresh range. */
  public async releaseSubnet(appUrn: AppUrn): Promise<void> {
    const existingApp = await this.appsRepository.getAppByUrn(appUrn);
    if (!existingApp?.subnet) {
      return;
    }

    await this.appsRepository.updateAppById(existingApp.id, { subnet: null });
    this.logger.info(`Released subnet ${existingApp.subnet} for app ${appUrn}`);
  }

  /** DB + Docker IPv4 ranges currently occupied on the host. */
  public async listOccupiedSubnets(excludeAppUrn?: AppUrn): Promise<OccupiedSubnet[]> {
    const apps = await this.appsRepository.getApps();
    return collectOccupiedSubnets(apps, this.docker, { excludeAppUrn });
  }

  private composeProjectName(appUrn: AppUrn): string {
    return appUrn.replace(':', '_');
  }

  private async isSubnetAvailable(subnet: string, appUrn: AppUrn): Promise<boolean> {
    const normalized = normalizeIpv4Cidr(subnet);
    if (!normalized) {
      return false;
    }

    const projectName = this.composeProjectName(appUrn);
    const occupied = await this.listOccupiedSubnets();

    for (const entry of occupied) {
      if (!cidrOverlaps(normalized, entry.cidr)) {
        continue;
      }

      if (entry.source === 'database') {
        if (entry.appUrn !== appUrn) {
          return false;
        }
        continue;
      }

      if (entry.composeProject !== projectName) {
        return false;
      }
    }

    return true;
  }

  /**
   * Find the next available Hub /24 that's not in use
   * @param occupied Unified DB + Docker occupancy entries
   * @returns The next available subnet or null if all are used
   */
  private findNextAvailableSubnet(occupied: OccupiedSubnet[], excludeSubnets: string[] = []): string | null {
    const occupiedCidrs = occupiedCidrStrings(occupied);
    const excludedPairs = new Set(
      excludeSubnets
        .map((subnet) => normalizeIpv4Cidr(subnet))
        .filter((subnet): subnet is string => Boolean(subnet))
        .map((subnet) => {
          const hubMatch = subnet.match(HUB_SUBNET_REGEX);
          return hubMatch ? `${hubMatch[1]}.${hubMatch[2]}` : null;
        })
        .filter((pair): pair is string => Boolean(pair)),
    );
    const blockedOctetPairs = this.blockedHubOctetPairs(occupiedCidrs);
    for (const pair of excludedPairs) {
      blockedOctetPairs.add(pair);
    }

    for (let y = STARTING_OCTET_2; y <= MAX_OCTET_VALUE; y++) {
      const startOctet3 = y === STARTING_OCTET_2 ? RESERVED_SUBNET_MAX_OCTET_3 + 1 : 0;

      for (let z = startOctet3; z <= MAX_OCTET_VALUE; z++) {
        const candidatePair = `${y}.${z}`;
        if (!blockedOctetPairs.has(candidatePair)) {
          return `10.${y}.${z}.0${SUBNET_MASK}`;
        }
      }
    }

    return null;
  }

  private blockedHubOctetPairs(occupiedCidrs: string[]): Set<string> {
    const blocked = new Set<string>();

    for (const cidr of occupiedCidrs) {
      const occupied = parseIpv4Cidr(cidr);
      if (!occupied) {
        continue;
      }

      const hubMatch = occupied.normalized.match(HUB_SUBNET_REGEX);
      if (hubMatch) {
        blocked.add(`${hubMatch[1]}.${hubMatch[2]}`);
        continue;
      }

      for (const pair of hubManagedOctetPairsOverlappingRange(occupied.start, occupied.end)) {
        blocked.add(pair);
      }
    }

    return blocked;
  }
}
