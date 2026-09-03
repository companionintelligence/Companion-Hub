import { Module, forwardRef } from '@nestjs/common';
import { PortalModule } from '@/core/portal/portal.module';
import { AppStoreModule } from '../app-stores/app-store.module';
import { RegistrationModule } from '../registration/registration.module';
import { ImageSizeService } from './image-size.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';

@Module({
  // AppStoreModule no longer imports MarketplaceModule — one-way dependency.
  // MarketplaceCacheBus is owned/exported by AppStoreModule (shared instance).
  imports: [PortalModule, AppStoreModule, forwardRef(() => RegistrationModule)],
  controllers: [MarketplaceController],
  providers: [MarketplaceService, ImageSizeService],
  exports: [MarketplaceService, ImageSizeService],
})
export class MarketplaceModule {}
