import { Module, forwardRef } from '@nestjs/common';
import { PortalModule } from '@/core/portal/portal.module';
import { DockerModule } from '../docker/docker.module';
import { EnvModule } from '../env/env.module';
import { InferenceModule } from '../inference/inference.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { QueueModule } from '../queue/queue.module';
import { PortAllocationRepository } from '../network/port-allocation.repository';
import { AppFilesManager } from './app-files-manager';
import { AppHelpers } from './app.helpers';
import { AppRuntimeMonitorService } from './app-runtime-monitor.service';
import { AppsController } from './apps.controller';
import { AppsRepository } from './apps.repository';
import { AppsService } from './apps.service';
import { AppIntentSyncService } from './app-intent-sync.service';
import { InstallPipelineTracker } from './install-pipeline.tracker';
import { RegistrationModule } from '../registration/registration.module';
import { ApiKeyModule } from '../api-keys/api-key.module';
import { MemoryConnectionModule } from '../memory-connect/memory-connection.module';

@Module({
  imports: [
    QueueModule,
    EnvModule,
    // forwardRef: PortalModule ↔ RegistrationModule; a hard import here made
    // CloudflareModule's PortalModule slot undefined during OpenAPI generation.
    forwardRef(() => PortalModule),
    forwardRef(() => DockerModule),
    forwardRef(() => InferenceModule),
    MarketplaceModule,
    forwardRef(() => RegistrationModule),
    ApiKeyModule,
    MemoryConnectionModule,
  ],
  controllers: [AppsController],
  providers: [
    AppFilesManager,
    AppsRepository,
    AppHelpers,
    AppsService,
    AppIntentSyncService,
    AppRuntimeMonitorService,
    PortAllocationRepository,
    InstallPipelineTracker,
  ],
  exports: [AppsRepository, AppFilesManager, AppHelpers, AppsService, AppIntentSyncService, AppRuntimeMonitorService, InstallPipelineTracker],
})
export class AppsModule {}
