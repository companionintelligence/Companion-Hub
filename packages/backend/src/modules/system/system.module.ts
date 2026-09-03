import { Module, forwardRef } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { SystemInspectorController } from './system-inspector.controller';
import { SystemInspectorService } from './system-inspector.service';
import { HostMetricsService } from './host-metrics.service';
import { ResourceAllocatorService } from './resource-allocator.service';
import { HostTelemetryService } from './host-telemetry.service';
import { FactoryResetController } from './factory-reset.controller';
import { FactoryResetService } from './factory-reset.service';
import { RegistrationModule } from '../registration/registration.module';
import { NetworkModule } from '../network/network.module';
import { DockerModule } from '../docker/docker.module';

@Module({
  imports: [forwardRef(() => NetworkModule), forwardRef(() => DockerModule), forwardRef(() => RegistrationModule)],
  controllers: [SystemController, SystemInspectorController, FactoryResetController],
  providers: [SystemService, SystemInspectorService, HostMetricsService, ResourceAllocatorService, HostTelemetryService, FactoryResetService],
  exports: [SystemService, HostMetricsService, ResourceAllocatorService, FactoryResetService, HostTelemetryService],
})
export class SystemModule {}
