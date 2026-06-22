import { Module, forwardRef } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { SystemInspectorController } from './system-inspector.controller';
import { SystemInspectorService } from './system-inspector.service';
import { HostMetricsService } from './host-metrics.service';
import { ResourceAllocatorService } from './resource-allocator.service';
import { NetworkModule } from '../network/network.module';
import { DockerModule } from '../docker/docker.module';

@Module({
  imports: [forwardRef(() => NetworkModule), forwardRef(() => DockerModule)],
  controllers: [SystemController, SystemInspectorController],
  providers: [SystemService, SystemInspectorService, HostMetricsService, ResourceAllocatorService],
  exports: [SystemService, HostMetricsService, ResourceAllocatorService],
})
export class SystemModule {}
