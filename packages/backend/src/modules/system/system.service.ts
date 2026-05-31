import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import si from 'systeminformation';

@Injectable()
export class SystemService {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly filesystem: FilesystemService,
  ) {}

  public async getSystemLoad() {
    const { currentLoad, cpus } = await si.currentLoad();

    const memResult = { total: 0, used: 0, available: 0 };

    // readTextFile returns null when the file is missing (never throws).
    // /host/proc/meminfo is only available inside the Docker stack; fall back
    // to systeminformation's si.mem() when running on the host.
    const memInfo = await this.filesystem.readTextFile('/host/proc/meminfo');
    if (memInfo) {
      memResult.total = Number(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0) * 1024;
      memResult.available = Number(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) * 1024;
      memResult.used = memResult.total - memResult.available;
    }

    if (!memResult.total) {
      // Fall back to systeminformation (works on macOS and Linux host).
      try {
        const mem = await si.mem();
        memResult.total = mem.total;
        memResult.available = mem.available;
        memResult.used = mem.used;
      } catch (e) {
        this.logger.error(`Unable to read memory info: ${e}`);
      }
    }

    const [disk0] = await si.fsSize();

    const disk = disk0 ?? { available: 0, size: 0 };
    const diskFree = Math.round(disk.available / 1024 / 1024 / 1024);
    const diskSize = Math.round(disk.size / 1024 / 1024 / 1024);
    const diskUsed = diskSize - diskFree;
    const percentUsed = Math.round((diskUsed / diskSize) * 100);

    const memoryTotal = Math.round(Number(memResult.total) / 1024 / 1024 / 1024);
    const memoryFree = Math.round(Number(memResult.available) / 1024 / 1024 / 1024);
    const percentUsedMemory = Math.round(((memoryTotal - memoryFree) / memoryTotal) * 100);

    return {
      diskUsed: diskUsed || 0,
      diskSize: diskSize || 0,
      percentUsed: percentUsed || 0,
      cpuLoad: currentLoad || 0,
      cpuCores: cpus?.length || 0,
      memoryTotal: memoryTotal || 0,
      percentUsedMemory: percentUsedMemory || 0,
    };
  }

  public async getLocalCertificate() {
    const { dataDir } = this.config.get('directories');
    const filePath = `${dataDir}/traefik/tls/cert.pem`;

    if (await this.filesystem.pathExists(filePath)) {
      const file = await this.filesystem.readTextFile(filePath);
      return file;
    }
  }

  public async detectDockerServices(): Promise<{ services: Array<{ name: string; image: string; status: string }> }> {
    try {
      const containers = await si.dockerContainers();
      const services = containers.map((c) => ({
        name: c.name,
        image: c.image,
        status: c.state,
      }));
      return { services };
    } catch (e) {
      this.logger.error(`Failed to detect Docker services: ${e}`);
      return { services: [] };
    }
  }
}
