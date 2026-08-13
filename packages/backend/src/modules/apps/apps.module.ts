import { Module, forwardRef } from '@nestjs/common';
import { PortalModule } from '@/core/portal/portal.module';
import { DockerModule } from '../docker/docker.module';
import { EnvModule } from '../env/env.module';
import { InferenceModule } from '../inference/inference.module';
import { QueueModule } from '../queue/queue.module';
import { AppHelpers } from './app.helpers';
import { AppRuntimeMonitorService } from './app-runtime-monitor.service';
import { AppsController } from './apps.controller';
import { AppsReadModule } from './apps-read.module';
import { AppsService } from './apps.service';
import { AppIntentSyncService } from './app-intent-sync.service';
import { RegistrationModule } from '../registration/registration.module';
import { ApiKeyModule } from '../api-keys/api-key.module';
import { MemoryConnectionModule } from '../memory-connect/memory-connection.module';

@Module({
  imports: [
    AppsReadModule,
    QueueModule,
    EnvModule,
    // forwardRef: PortalModule ↔ RegistrationModule; a hard import here made
    // CloudflareModule's PortalModule slot undefined during OpenAPI generation.
    forwardRef(() => PortalModule),
    forwardRef(() => DockerModule),
    forwardRef(() => InferenceModule),
    forwardRef(() => RegistrationModule),
    ApiKeyModule,
    MemoryConnectionModule,
    // McpProbe is resolved lazily via ModuleRef in AppsController (no Apps → Mcp Nest edge).
  ],
  controllers: [AppsController],
  providers: [AppHelpers, AppsService, AppIntentSyncService, AppRuntimeMonitorService],
  exports: [AppsReadModule, AppHelpers, AppsService, AppIntentSyncService, AppRuntimeMonitorService],
})
export class AppsModule {}
