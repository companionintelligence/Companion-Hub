import { TranslatableError } from '@/common/error/translatable-error';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { AppsRepository } from '../apps/apps.repository';
import { PortAllocationRepository } from './port-allocation.repository';
import net from 'node:net';

/** Reserved port ranges that must never be allocated */
const RESERVED_RANGES: Array<[number, number]> = [
  [0, 1023], // Well-known / privileged
  [5432, 5432], // PostgreSQL (Hub DB)
  [5672, 5672], // RabbitMQ AMQP
  [15672, 15672], // RabbitMQ management
  [6543, 6543], // ci-hub-db mapped port
  [5001, 5001], // ci-os-hub-queue mapped port
  [5002, 5002], // ci-os-hub mapped port
  [9480, 9480], // Traefik HTTP
  [9443, 9443], // Traefik HTTPS
  [3000, 3000], // Hub backend (dev)
  [9091, 9092], // Hub frontend (dev)
];

/** Default port range for dynamic allocation */
const DYNAMIC_PORT_MIN = 10000;
const DYNAMIC_PORT_MAX = 60000;

/** How many times to retry if a port turns out to be in use */
const MAX_PROBE_RETRIES = 10;

export interface PortAllocation {
  id: number;
  appUrn: string;
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
  label: string; // e.g. 'main', 'admin-ui', 'api', 'ldap'
  createdAt: string;
}

@Injectable()
export class PortManagerService {
  constructor(
    private readonly portAllocationRepo: PortAllocationRepository,
    readonly _appsRepository: AppsRepository,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Allocate one or more ports for an app.
   *
   * Each request item specifies:
   * - containerPort: the port inside the container
   * - protocol: tcp or udp (default tcp)
   * - label: human-readable label (e.g. 'main', 'admin-ui')
   * - preferredHostPort: optional hint — will be used if available
   *
   * Returns the allocated PortAllocations.
   */
  public async allocatePorts(
    appUrn: AppUrn,
    requests: Array<{
      containerPort: number;
      protocol?: 'tcp' | 'udp';
      label: string;
      preferredHostPort?: number;
    }>,
  ): Promise<PortAllocation[]> {
    const allocations: PortAllocation[] = [];

    for (const req of requests) {
      const protocol = req.protocol ?? 'tcp';
      const allocation = await this.allocateWithRetry(appUrn, req.containerPort, protocol, req.label, req.preferredHostPort);

      this.logger.info(`Port allocated: ${allocation.hostPort}:${req.containerPort}/${protocol} [${req.label}] for ${appUrn}`);
      allocations.push(allocation);
    }

    return allocations;
  }

  /**
   * Attempt to allocate a port, retrying on unique constraint violations (concurrent installs).
   */
  private async allocateWithRetry(
    appUrn: AppUrn,
    containerPort: number,
    protocol: 'tcp' | 'udp',
    label: string,
    preferredHostPort?: number,
    attempt = 0,
  ): Promise<PortAllocation> {
    const maxRetries = 3;
    let hostPort: number;

    if (attempt === 0 && preferredHostPort && (await this.isPortAvailable(preferredHostPort, protocol))) {
      hostPort = preferredHostPort;
    } else {
      hostPort = await this.findAvailablePort(protocol);
    }

    try {
      return await this.portAllocationRepo.create({ appUrn, hostPort, containerPort, protocol, label });
    } catch (err) {
      const isConstraintViolation =
        err instanceof Error && (err.message.includes('unique') || err.message.includes('duplicate') || err.message.includes('23505'));
      if (isConstraintViolation && attempt < maxRetries) {
        this.logger.warn(`Port ${hostPort}/${protocol} conflict on insert (attempt ${attempt + 1}/${maxRetries}), retrying...`);
        return this.allocateWithRetry(appUrn, containerPort, protocol, label, undefined, attempt + 1);
      }
      throw err;
    }
  }

  /**
   * Release all port allocations for an app.
   */
  public async releaseAll(appUrn: AppUrn): Promise<number> {
    const count = await this.portAllocationRepo.deleteByAppUrn(appUrn);
    if (count > 0) {
      this.logger.info(`Released ${count} port allocation(s) for ${appUrn}`);
    }
    return count;
  }

  /**
   * Get all port allocations for an app.
   */
  public async getAppPorts(appUrn: AppUrn): Promise<PortAllocation[]> {
    return this.portAllocationRepo.getByAppUrn(appUrn);
  }

  /**
   * Get the main (primary) host port for an app — the one labelled 'main'.
   */
  public async getMainPort(appUrn: AppUrn): Promise<number | null> {
    const allocations = await this.portAllocationRepo.getByAppUrn(appUrn);
    const main = allocations.find((a) => a.label === 'main');
    return main?.hostPort ?? null;
  }

  /**
   * Get all port allocations across all apps.
   */
  public async getAllAllocations(): Promise<PortAllocation[]> {
    return this.portAllocationRepo.getAll();
  }

  /**
   * Check whether a specific host port is available (not allocated and not reserved).
   */
  public async isPortAvailable(port: number, protocol: 'tcp' | 'udp' = 'tcp'): Promise<boolean> {
    if (this.isReserved(port)) return false;

    const existing = await this.portAllocationRepo.getByHostPort(port, protocol);
    if (existing) return false;

    // Probe the port to catch anything bound outside our tracking
    if (protocol === 'tcp') {
      return this.probeTcpPort(port);
    }

    return true;
  }

  /**
   * Find the next available host port in the dynamic range.
   */
  private async findAvailablePort(protocol: 'tcp' | 'udp'): Promise<number> {
    const allocated = await this.portAllocationRepo.getAllHostPorts(protocol);
    const allocatedSet = new Set(allocated);

    for (let attempt = 0; attempt < MAX_PROBE_RETRIES; attempt++) {
      for (let port = DYNAMIC_PORT_MIN; port <= DYNAMIC_PORT_MAX; port++) {
        if (this.isReserved(port)) continue;
        if (allocatedSet.has(port)) continue;

        if (protocol === 'tcp') {
          const free = await this.probeTcpPort(port);
          if (free) return port;
          // Port is in use by something outside our tracking — skip it
          allocatedSet.add(port);
        } else {
          return port;
        }
      }
    }

    throw new TranslatableError('NETWORK_ERROR_NO_AVAILABLE_PORTS', {
      message: `No available ${protocol} ports in range ${DYNAMIC_PORT_MIN}-${DYNAMIC_PORT_MAX}`,
    });
  }

  /**
   * Check if a port falls within a reserved range.
   */
  private isReserved(port: number): boolean {
    return RESERVED_RANGES.some(([min, max]) => port >= min && port <= max);
  }

  /**
   * Probe a TCP port to check if anything is currently listening.
   * Returns true if the port is free.
   */
  private probeTcpPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '0.0.0.0');
    });
  }

  /**
   * Migrate an existing app's single-port allocation into the port_allocation table.
   * Called during bootstrap to backfill apps that were installed before the port manager existed.
   */
  public async migrateExistingApp(appUrn: AppUrn, hostPort: number, containerPort: number): Promise<void> {
    const existing = await this.portAllocationRepo.getByAppUrn(appUrn);
    if (existing.length > 0) return; // Already migrated

    await this.portAllocationRepo.create({
      appUrn,
      hostPort,
      containerPort,
      protocol: 'tcp',
      label: 'main',
    });

    this.logger.debug(`Backfilled port allocation for ${appUrn}: ${hostPort}:${containerPort}/tcp`);
  }
}
