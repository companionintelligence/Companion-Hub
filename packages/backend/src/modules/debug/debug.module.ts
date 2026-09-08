import { Module, forwardRef } from '@nestjs/common';
import { DebugController } from './debug.controller';
import { DebugService } from './debug.service';
import { TelemetryFeedbackService } from './telemetry-feedback.service';
import { DatabaseModule } from '@/core/database/database.module';
import { AppLifecycleModule } from '../app-lifecycle/app-lifecycle.module';
import { BackupsModule } from '../backups/backups.module';
import { AppStoreModule } from '../app-stores/app-store.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { DockerModule } from '../docker/docker.module';
import { SystemModule } from '../system/system.module';

@Module({
  imports: [
    DatabaseModule,
    AppLifecycleModule,
    BackupsModule,
    AppStoreModule,
    MarketplaceModule,
    forwardRef(() => DockerModule),
    forwardRef(() => SystemModule),
  ],
  controllers: [DebugController],
  providers: [DebugService, TelemetryFeedbackService],
  exports: [DebugService, TelemetryFeedbackService],
})
export class DebugModule {}
