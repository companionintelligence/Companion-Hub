import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import si from 'systeminformation';
import { HostMetricsService } from './host-metrics.service';

@Injectable()
export class SystemService {
  constructor(
    private readonly logger: LoggerService,
    private readonly hostMetrics: HostMetricsService,
  ) {}

  public async getSystemLoad() {
    const { currentLoad, cpus } = await si.currentLoad();
    return this.hostMetrics.getDisplayLoad(currentLoad || 0, cpus?.length || 0);
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
