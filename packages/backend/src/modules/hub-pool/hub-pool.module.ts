import { forwardRef, Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { FilesystemModule } from '@/core/filesystem/filesystem.module';
import { EncryptionModule } from '@/core/encryption/encryption.module';
import { TailscaleModule } from '@/modules/tailscale/tailscale.module';
import { InferenceModule } from '@/modules/inference/inference.module';
import { PortalModule } from '@/core/portal/portal.module';
import { ApiKeyModule } from '@/modules/api-keys/api-key.module';
import { InferenceAccessGuard } from '@/modules/auth/inference-access.guard';
import { HubPoolController } from './hub-pool.controller';
import { HubPoolOllamaCompatController } from './hub-pool-ollama-compat.controller';
import { HubPoolPeerRepository } from './hub-pool-peer.repository';
import { HubPoolIdentityRepository } from './hub-pool-identity.repository';
import { HubPoolIdentityService } from './hub-pool-identity.service';
import { HubPoolPairingPinService } from './hub-pool-pairing-pin.service';
import { HubPoolPeerService } from './hub-pool-peer.service';
import { HubPoolLoadService } from './hub-pool-load.service';
import { HubPoolRoutingLogService } from './hub-pool-routing-log.service';
import { PoolProxyService } from './hub-pool-proxy.service';
import { HubPoolDiscoveryService } from './hub-pool-discovery.service';
import { HubPoolPinService } from './hub-pool-pin.service';
import { HubPoolPressureService } from './hub-pool-pressure.service';
import { HubPoolThroughputService } from './hub-pool-throughput.service';
import { PoolPeerGuard } from './guards/pool-peer.guard';

// forwardRef with InferenceModule: HubPoolPeerService needs InferenceRouterService (to report this
// node's own capabilities to peers) and InferenceEndpointService needs HubPoolPeerService (to know
// whether to route an app's inference endpoints through the pool proxy — for both the generated
// app.env and the credentials.env an app bootstraps from) — same circular shape already used
// between AppsModule and InferenceModule.
//
// ApiKeyModule is here for InferenceAccessGuard's key leg. No forwardRef: it imports only
// LoggerModule and the global database module, so there is no path back to this one.
@Module({
  imports: [
    LoggerModule,
    FilesystemModule,
    EncryptionModule,
    TailscaleModule,
    ApiKeyModule,
    forwardRef(() => InferenceModule),
    forwardRef(() => PortalModule),
  ],
  controllers: [HubPoolController, HubPoolOllamaCompatController],
  providers: [
    HubPoolPeerRepository,
    HubPoolIdentityRepository,
    HubPoolIdentityService,
    HubPoolPairingPinService,
    HubPoolLoadService,
    HubPoolRoutingLogService,
    HubPoolPressureService,
    HubPoolThroughputService,
    HubPoolPeerService,
    HubPoolDiscoveryService,
    HubPoolPinService,
    PoolProxyService,
    InferenceAccessGuard,
    PoolPeerGuard,
  ],
  exports: [HubPoolPeerService, PoolProxyService, HubPoolIdentityService],
})
export class HubPoolModule {}
