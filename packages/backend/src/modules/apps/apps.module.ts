import { Module, forwardRef } from '@nestjs/common';
import { PortalModule } from '@/core/portal/portal.module';
import { DockerModule } from '../docker/docker.module';
import { EnvModule } from '../env/env.module';
import { InferenceModule } from '../inference/inference.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { QueueModule } from '../queue/queue.module';
import { AppHelpers } from './app.helpers';
import { AppRuntimeMonitorService } from './app-runtime-monitor.service';
import { AppsController } from './apps.controller';
import { AppsReadModule } from './apps-read.module';
import { AppsService } from './apps.service';
import { AppIntentSyncService } from './app-intent-sync.service';
import { InferenceEnvStalenessService } from './inference-env-staleness.service';
import { RegistrationModule } from '../registration/registration.module';
import { ApiKeyModule } from '../api-keys/api-key.module';
import { MemoryConnectionModule } from '../memory-connect/memory-connection.module';
import { SystemModule } from '../system/system.module';
import { POOL_CONTAINER_SAMPLER } from '@/common/helpers/hub-pool';

@Module({
  imports: [
    AppsReadModule,
    // AppsService still calls MarketplaceService for ignore-version update metadata.
    MarketplaceModule,
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
    forwardRef(() => SystemModule),
    // McpProbe is resolved lazily via ModuleRef in AppsController (no Apps → Mcp Nest edge).
  ],
  controllers: [AppsController],
  providers: [
    AppHelpers,
    AppsService,
    AppIntentSyncService,
    AppRuntimeMonitorService,
    InferenceEnvStalenessService,
    // The Hub pool publishes an aggregate container rollup to its peers and reads it from the
    // sample this monitor has already collected. It resolves this token through ModuleRef with
    // `strict: false` rather than injecting the class, so there is no HubPoolModule -> AppsModule
    // Nest edge: that edge would close a second cycle (Apps -> Inference -> HubPool) and pull the
    // whole apps graph into the pool's. The token is declared in a leaf helper, so nothing here
    // imports from modules/hub-pool. See `PoolContainerSampler`.
    { provide: POOL_CONTAINER_SAMPLER, useExisting: AppRuntimeMonitorService },
  ],
  exports: [
    AppsReadModule,
    AppHelpers,
    AppsService,
    AppIntentSyncService,
    AppRuntimeMonitorService,
    InferenceEnvStalenessService,
    POOL_CONTAINER_SAMPLER,
  ],
})
export class AppsModule {}
