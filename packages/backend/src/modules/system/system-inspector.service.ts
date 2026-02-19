import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import si from 'systeminformation';
import Dockerode from 'dockerode';
import { Inject } from '@nestjs/common';
import { DOCKERODE } from '@/modules/docker/docker.module';
import net from 'node:net';
import os from 'node:os';

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: Array<{ hostPort: number | null; containerPort: number; protocol: string }>;
  appUrn: string | null;
  created: number;
  uptime: string;
}

interface PortStatus {
  hostPort: number;
  containerPort: number;
  protocol: string;
  label: string;
  appUrn: string;
  bound: boolean;
  containerName: string | null;
  containerState: string | null;
}

interface SystemHealth {
  cpu: { load: number; cores: number; model: string };
  memory: { total: number; used: number; free: number; percent: number };
  disk: { total: number; used: number; free: number; percent: number };
  uptime: number;
  platform: string;
  hostname: string;
  dockerVersion: string | null;
  containerCount: { running: number; stopped: number; total: number };
}

@Injectable()
export class SystemInspectorService {
  constructor(
    private readonly logger: LoggerService,
    private readonly portManager: PortManagerService,
    readonly _appsRepo: AppsRepository,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
  ) {}

  async getFullInspection() {
    const [containers, ports, health] = await Promise.all([this.getContainers(), this.getPortStatus(), this.getSystemHealth()]);
    return { containers, ports, health, timestamp: new Date().toISOString() };
  }

  async getContainers(): Promise<ContainerInfo[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      return containers.map((c) => {
        const names = c.Names?.map((n) => n.replace(/^\//, '')) || [];
        const appUrn = c.Labels?.['ci-os-hub.appurn'] || null;
        const ports = (c.Ports || []).map((p) => ({
          hostPort: p.PublicPort || null,
          containerPort: p.PrivatePort,
          protocol: p.Type || 'tcp',
        }));

        const created = c.Created || 0;
        const uptimeMs = Date.now() - created * 1000;
        const uptime = this.formatUptime(uptimeMs);

        return {
          id: c.Id?.substring(0, 12) || '',
          name: names[0] || c.Id?.substring(0, 12) || 'unknown',
          image: c.Image || '',
          state: c.State || 'unknown',
          status: c.Status || '',
          ports,
          appUrn,
          created,
          uptime: c.State === 'running' ? uptime : '-',
        };
      });
    } catch (err) {
      this.logger.error(`Failed to list containers: ${err}`);
      return [];
    }
  }

  async getPortStatus(): Promise<{ allocations: PortStatus[]; untracked: Array<{ port: number; process: string }> }> {
    try {
      const allocations = await this.portManager.getAllAllocations();
      const containers = await this.getContainers();

      // Build a map of host port → container info
      const portToContainer = new Map<number, { name: string; state: string }>();
      for (const container of containers) {
        for (const p of container.ports) {
          if (p.hostPort) {
            portToContainer.set(p.hostPort, { name: container.name, state: container.state });
          }
        }
      }

      const portStatuses: PortStatus[] = await Promise.all(
        allocations.map(async (alloc) => {
          const containerInfo = portToContainer.get(alloc.hostPort);
          let bound = false;
          if (containerInfo) {
            bound = containerInfo.state === 'running';
          } else {
            bound = await this.isPortBound(alloc.hostPort);
          }

          return {
            hostPort: alloc.hostPort,
            containerPort: alloc.containerPort,
            protocol: alloc.protocol,
            label: alloc.label,
            appUrn: alloc.appUrn,
            bound,
            containerName: containerInfo?.name || null,
            containerState: containerInfo?.state || null,
          };
        }),
      );

      // Find untracked ports (bound on host but not in our allocation table)
      const trackedPorts = new Set(allocations.map((a) => a.hostPort));
      const untrackedPorts: Array<{ port: number; process: string }> = [];
      for (const [port, info] of portToContainer) {
        if (!trackedPorts.has(port)) {
          untrackedPorts.push({ port, process: info.name });
        }
      }

      return { allocations: portStatuses, untracked: untrackedPorts };
    } catch (err) {
      this.logger.error(`Failed to get port status: ${err}`);
      return { allocations: [], untracked: [] };
    }
  }

  async getSystemHealth(): Promise<SystemHealth> {
    try {
      const [cpuLoad, cpuInfo, mem, disk, dockerInfo] = await Promise.all([
        si.currentLoad(),
        si.cpu(),
        this.getMemoryInfo(),
        si.fsSize(),
        this.getDockerInfo(),
      ]);

      const disk0 = disk[0] ?? { available: 0, size: 0, used: 0 };

      return {
        cpu: {
          load: Math.round(cpuLoad.currentLoad * 10) / 10,
          cores: cpuInfo.cores,
          model: `${cpuInfo.manufacturer} ${cpuInfo.brand}`,
        },
        memory: {
          total: mem.total,
          used: mem.used,
          free: mem.available,
          percent: mem.total > 0 ? Math.round(((mem.total - mem.available) / mem.total) * 100) : 0,
        },
        disk: {
          total: Math.round(disk0.size / 1024 / 1024 / 1024),
          used: Math.round((disk0.size - disk0.available) / 1024 / 1024 / 1024),
          free: Math.round(disk0.available / 1024 / 1024 / 1024),
          percent: disk0.size > 0 ? Math.round(((disk0.size - disk0.available) / disk0.size) * 100) : 0,
        },
        uptime: os.uptime(),
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        hostname: os.hostname(),
        dockerVersion: dockerInfo.version,
        containerCount: dockerInfo.containers,
      };
    } catch (err) {
      this.logger.error(`Failed to get system health: ${err}`);
      return {
        cpu: { load: 0, cores: 0, model: 'unknown' },
        memory: { total: 0, used: 0, free: 0, percent: 0 },
        disk: { total: 0, used: 0, free: 0, percent: 0 },
        uptime: 0,
        platform: 'unknown',
        hostname: 'unknown',
        dockerVersion: null,
        containerCount: { running: 0, stopped: 0, total: 0 },
      };
    }
  }

  private async getMemoryInfo() {
    try {
      const mem = await si.mem();
      return { total: mem.total, used: mem.used, available: mem.available };
    } catch {
      return { total: os.totalmem(), used: os.totalmem() - os.freemem(), available: os.freemem() };
    }
  }

  private async getDockerInfo(): Promise<{ version: string | null; containers: { running: number; stopped: number; total: number } }> {
    try {
      const info = await this.docker.info();
      return {
        version: info.ServerVersion || null,
        containers: {
          running: info.ContainersRunning || 0,
          stopped: info.ContainersStopped || 0,
          total: info.Containers || 0,
        },
      };
    } catch {
      return { version: null, containers: { running: 0, stopped: 0, total: 0 } };
    }
  }

  private isPortBound(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(true));
      server.once('listening', () => {
        server.close(() => resolve(false));
      });
      server.listen(port, '0.0.0.0');
    });
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }
}
