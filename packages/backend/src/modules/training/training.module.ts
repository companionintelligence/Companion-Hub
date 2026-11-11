import { forwardRef, Module } from '@nestjs/common';
import { HubPoolModule } from '@/modules/hub-pool/hub-pool.module';
import { HubPoolPeerRepository } from '@/modules/hub-pool/hub-pool-peer.repository';
import { HubPoolIdentityRepository } from '@/modules/hub-pool/hub-pool-identity.repository';
import { HubPoolIdentityService } from '@/modules/hub-pool/hub-pool-identity.service';
import { PoolPeerGuard } from '@/modules/hub-pool/guards/pool-peer.guard';
import { FilesystemModule } from '@/core/filesystem/filesystem.module';
import { LoggerModule } from '@/core/logger/logger.module';
import { TrainingController } from './training.controller';
import { TrainingRunnerService } from './training-runner.service';
import { TrainingGovernorService } from './training-governor.service';
import { TrainingPoolService } from './training-pool.service';

@Module({
  imports: [
    LoggerModule,
    FilesystemModule,
    forwardRef(() => HubPoolModule),
  ],
  controllers: [TrainingController],
  providers: [
    HubPoolPeerRepository,
    HubPoolIdentityRepository,
    HubPoolIdentityService,
    PoolPeerGuard,
    TrainingGovernorService,
    TrainingRunnerService,
    TrainingPoolService,
  ],
  exports: [TrainingRunnerService, TrainingPoolService, TrainingGovernorService],
})
export class TrainingModule {}
