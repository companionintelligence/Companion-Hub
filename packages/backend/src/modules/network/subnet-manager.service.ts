import { TranslatableError } from '@/common/error/translatable-error';
import { LoggerService } from '@/core/logger/logger.service';
import { Inject, Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import Dockerode from 'dockerode';
import { AppsRepository } from '../apps/apps.repository';
import { DOCKERODE } from '../docker/constants';
import { cidrConflictsWithAny, cidrOverlaps } from './cidr-overlap';

const SUBNET_MASK = '/24';
const MAX_RETRIES = 3;
const STARTING_OCTET_2 = 128;
const MAX_OCTET_VALUE = 254;
const RESERVED_SUBNET_MAX_OCTET_3 = 9;

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
  public async allocateSubnet(appUrn: AppUrn, retryCount = 0): Promise<string> {
    const existingApp = await this.appsRepository.getAppByUrn(appUrn);

    if (!existingApp) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND');
    }

    if (existingApp.subnet) {
      const available = await this.isSubnetAvailable(existingApp.subnet, appUrn);
      if (available) {
        this.logger.info(`App ${appUrn} already has subnet ${existingApp.subnet}`);
        return existingApp.subnet;
      }

      this.logger.warn(`App ${appUrn} subnet ${existingApp.subnet} conflicts with Docker; reassigning`);
      await this.appsRepository.updateAppById(existingApp.id, { subnet: null });
    }

    const allocatedSubnets = await this.collectOccupiedCidrs(appUrn);
    const nextSubnet = this.findNextAvailableSubnet(allocatedSubnets);

    if (!nextSubnet) {
      throw new TranslatableError('NETWORK_ERROR_NO_AVAILABLE_SUBNETS');
    }

    try {
      await this.appsRepository.updateAppById(existingApp.id, { subnet: nextSubnet });
    } catch (error) {
      if (error instanceof Error && retryCount < MAX_RETRIES) {
        this.logger.error(`Subnet ${nextSubnet} failed to be allocated, retrying...`);
        return this.allocateSubnet(appUrn, retryCount + 1);
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

  private async isSubnetAvailable(subnet: string, appUrn: AppUrn): Promise<boolean> {
    const projectName = appUrn.replace(':', '_');
    const networks = await this.docker.listNetworks();

    for (const network of networks ?? []) {
      for (const config of network.IPAM?.Config ?? []) {
        const dockerSubnet = config.Subnet;
        if (!dockerSubnet || !cidrOverlaps(subnet, dockerSubnet)) {
          continue;
        }

        const networkProject = network.Labels?.['com.docker.compose.project'];
        if (networkProject !== projectName) {
          return false;
        }
      }
    }

    const apps = await this.appsRepository.getApps();
    for (const record of apps) {
      const recordUrn = `${record.appName}:${record.appStoreSlug}` as AppUrn;
      if (recordUrn === appUrn || !record.subnet) {
        continue;
      }
      if (cidrOverlaps(subnet, record.subnet)) {
        return false;
      }
    }

    return true;
  }

  /** Subnets reserved in the DB (excluding this app) plus live Docker IPAM ranges. */
  private async collectOccupiedCidrs(excludeAppUrn?: AppUrn): Promise<string[]> {
    const apps = await this.appsRepository.getApps();
    const appSubnets = apps
      .filter((record) => {
        if (!excludeAppUrn) {
          return true;
        }
        const recordUrn = `${record.appName}:${record.appStoreSlug}` as AppUrn;
        return recordUrn !== excludeAppUrn;
      })
      .map((record) => record.subnet)
      .filter((subnet): subnet is string => subnet !== null);

    const networks = await this.docker.listNetworks();
    const dockerSubnets = (networks ?? [])
      .flatMap((network) => network.IPAM?.Config ?? [])
      .map((config) => config.Subnet)
      .filter((subnet): subnet is string => Boolean(subnet));

    return [...new Set([...appSubnets, ...dockerSubnets])];
  }

  /**
   * Find the next available subnet that's not in use
   * @param occupiedCidrs CIDR ranges already in use on the host
   * @returns The next available subnet or null if all are used
   */
  private findNextAvailableSubnet(occupiedCidrs: string[]): string | null {
    const blockedOctetPairs = new Set<string>();
    const hubSubnetRegex = /^10\.(\d{1,3})\.(\d{1,3})\.0\/24$/;

    for (const occupied of occupiedCidrs) {
      const match = occupied.match(hubSubnetRegex);
      if (match) {
        blockedOctetPairs.add(`${match[1]}.${match[2]}`);
        continue;
      }

      for (let y = STARTING_OCTET_2; y <= MAX_OCTET_VALUE; y++) {
        const startOctet3 = y === STARTING_OCTET_2 ? RESERVED_SUBNET_MAX_OCTET_3 + 1 : 0;
        for (let z = startOctet3; z <= MAX_OCTET_VALUE; z++) {
          const candidate = `10.${y}.${z}.0${SUBNET_MASK}`;
          if (cidrConflictsWithAny(candidate, [occupied])) {
            blockedOctetPairs.add(`${y}.${z}`);
          }
        }
      }
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
}
