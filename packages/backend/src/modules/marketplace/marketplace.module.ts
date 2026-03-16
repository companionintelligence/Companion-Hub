import { Module, forwardRef } from '@nestjs/common';
import { AppStoreModule } from '../app-stores/app-store.module';
import { RegistrationModule } from '../registration/registration.module';
import { ImageSizeService } from './image-size.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';

@Module({
  imports: [AppStoreModule, forwardRef(() => RegistrationModule)],
  controllers: [MarketplaceController],
  providers: [MarketplaceService, ImageSizeService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
