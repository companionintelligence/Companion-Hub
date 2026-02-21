import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SystemInspectorService } from '@/modules/system/system-inspector.service';
import { ToolRegistry } from './tool-registry';

@Injectable()
export class SystemTools implements OnModuleInit {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly systemInspectorService: SystemInspectorService,
  ) {}

  onModuleInit() {
    this.toolRegistry.register({
      name: 'get_system_health',
      description:
        'Get current system health: CPU usage, memory, disk, uptime, Docker version, container counts. Use to check if the system can handle new apps.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const health = await this.systemInspectorService.getSystemHealth();
        return JSON.stringify({
          cpu: health.cpu,
          memory: health.memory,
          disk: health.disk,
          uptime: health.uptime,
          hostname: health.hostname,
          dockerVersion: health.dockerVersion,
          containers: health.containerCount,
        });
      },
    });
  }
}
