import { Module, forwardRef } from '@nestjs/common';
import { PortalModule } from '@/core/portal/portal.module';
import { QueueModule } from '../queue/queue.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { AppStoreRepository } from './app-store.repository';
import { AppStoreService } from './app-store.service';
import { ReposHelpers } from './repos.helpers';
import { RegistrationModule } from '../registration/registration.module';

@Module({
  imports: [PortalModule, QueueModule, forwardRef(() => RegistrationModule), forwardRef(() => MarketplaceModule)],
  controllers: [],
  providers: [AppStoreService, AppStoreRepository, ReposHelpers],
  exports: [AppStoreService, ReposHelpers, AppStoreRepository],
})
export class AppStoreModule {}
