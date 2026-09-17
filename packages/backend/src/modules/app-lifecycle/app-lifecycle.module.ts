import { SSEModule } from '@/core/sse/sse.module';
import { StatusReportModule } from '../status-report/status-report.module';
import { HubAccessService } from './hub-access.service';
import { ApiKeyModule } from '@/modules/api-keys/api-key.module';
import { Module, forwardRef } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { BackupsModule } from '../backups/backups.module';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { DockerModule } from '../docker/docker.module';
import { EnvModule } from '../env/env.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { AppStoreModule } from '../app-stores/app-store.module';
import { QueueModule } from '../queue/queue.module';
import { RegistrationModule } from '../registration/registration.module';
import { TailscaleModule } from '../tailscale/tailscale.module';
import { UserModule } from '../user/user.module';
import { NetworkModule } from '../network/network.module';
import { AppRehydrationService } from './app-rehydration.service';
import { AppInstallValidator } from './app-install-validator.service';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { AppLifecycleController } from './app-lifecycle.controller';
import { AppLifecycleService } from './app-lifecycle.service';
import { ExposureSyncService } from './exposure-sync.service';
import { AppOperationRegistry } from './app-operation-registry';
import { AppStatusSyncService } from './app-status-sync.service';
import { PortalModule } from '@/core/portal/portal.module';
import { LifecycleJobService } from './lifecycle-job.service';
import { InferenceModule } from '../inference/inference.module';
import { AiAppInferenceRefreshService } from './ai-app-inference-refresh.service';

@Module({
  imports: [
    StatusReportModule,
    QueueModule,
    forwardRef(() => AppsModule),
    EnvModule,
    DockerModule,
    MarketplaceModule,
    AppStoreModule,
    forwardRef(() => BackupsModule),
    SSEModule,
    CloudflareModule,
    RegistrationModule,
    TailscaleModule,
    UserModule,
    NetworkModule,
    ApiKeyModule,
    PortalModule,
    // forwardRef for the same reason AppsModule uses one: Inference -> HubPool -> Inference.
    forwardRef(() => InferenceModule),
  ],
  providers: [
    HubAccessService,
    AppLifecycleService,
    AppInstallValidator,
    ExposureSyncService,
    AppLifecycleCommandFactory,
    AppOperationRegistry,
    AppStatusSyncService,
    AppRehydrationService,
    LifecycleJobService,
    AiAppInferenceRefreshService,
  ],
  controllers: [AppLifecycleController],
  exports: [
    AppLifecycleService,
    AppInstallValidator,
    ExposureSyncService,
    AppOperationRegistry,
    AppStatusSyncService,
    AppRehydrationService,
    LifecycleJobService,
    AiAppInferenceRefreshService,
  ],
})
export class AppLifecycleModule {}
