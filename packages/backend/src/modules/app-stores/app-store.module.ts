import { Module, forwardRef } from '@nestjs/common';
import { PortalModule } from '@/core/portal/portal.module';
import { QueueModule } from '../queue/queue.module';
import { MarketplaceCacheBus } from '../marketplace/marketplace-cache.bus';
import { AppStoreRepository } from './app-store.repository';
import { AppStoreService } from './app-store.service';
import { ReposHelpers } from './repos.helpers';
import { RegistrationModule } from '../registration/registration.module';

@Module({
  // MarketplaceCacheBus lives here so AppStore can invalidate catalog caches without
  // importing MarketplaceModule (breaks AppStore ↔ Marketplace Nest cycle).
  imports: [PortalModule, QueueModule, forwardRef(() => RegistrationModule)],
  controllers: [],
  providers: [AppStoreService, AppStoreRepository, ReposHelpers, MarketplaceCacheBus],
  exports: [AppStoreService, ReposHelpers, AppStoreRepository, MarketplaceCacheBus],
})
export class AppStoreModule {}
