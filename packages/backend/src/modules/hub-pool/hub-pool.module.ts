import { forwardRef, Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { FilesystemModule } from '@/core/filesystem/filesystem.module';
import { EncryptionModule } from '@/core/encryption/encryption.module';
import { TailscaleModule } from '@/modules/tailscale/tailscale.module';
import { InferenceModule } from '@/modules/inference/inference.module';
import { HubPoolController } from './hub-pool.controller';
import { HubPoolPeerRepository } from './hub-pool-peer.repository';
import { HubPoolPeerService } from './hub-pool-peer.service';
import { HubPoolLoadService } from './hub-pool-load.service';
import { HubPoolRoutingLogService } from './hub-pool-routing-log.service';
import { PoolProxyService } from './hub-pool-proxy.service';
import { HubPoolPressureService } from './hub-pool-pressure.service';
import { PoolAppGuard } from './guards/pool-app.guard';
import { PoolPeerGuard } from './guards/pool-peer.guard';

// forwardRef with InferenceModule: HubPoolPeerService needs InferenceRouterService (to report this
// node's own capabilities to peers) and InferenceEnvResolver needs HubPoolPeerService (to know
// whether to route an app's CI_LLM_BASE_URL through the pool proxy) — same circular shape already
// used between AppsModule and InferenceModule.
@Module({
  imports: [LoggerModule, FilesystemModule, EncryptionModule, TailscaleModule, forwardRef(() => InferenceModule)],
  controllers: [HubPoolController],
  providers: [
    HubPoolPeerRepository,
    HubPoolLoadService,
    HubPoolRoutingLogService,
    HubPoolPressureService,
    HubPoolPeerService,
    PoolProxyService,
    PoolAppGuard,
    PoolPeerGuard,
  ],
  exports: [HubPoolPeerService, PoolProxyService],
})
export class HubPoolModule {}
