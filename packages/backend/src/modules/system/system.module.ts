import { Module, forwardRef } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { SystemInspectorController } from './system-inspector.controller';
import { SystemInspectorService } from './system-inspector.service';
import { HostMetricsService } from './host-metrics.service';
import { ResourceAllocatorService } from './resource-allocator.service';
import { FactoryResetController } from './factory-reset.controller';
import { FactoryResetService } from './factory-reset.service';
import { NetworkModule } from '../network/network.module';
import { DockerModule } from '../docker/docker.module';

@Module({
  imports: [forwardRef(() => NetworkModule), forwardRef(() => DockerModule)],
  controllers: [SystemController, SystemInspectorController, FactoryResetController],
  providers: [SystemService, SystemInspectorService, HostMetricsService, ResourceAllocatorService, FactoryResetService],
  exports: [SystemService, HostMetricsService, ResourceAllocatorService, FactoryResetService],
})
export class SystemModule {}
