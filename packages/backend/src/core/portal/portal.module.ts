import { Module, forwardRef } from '@nestjs/common';
import { ConfigurationModule } from '../config/configuration.module';
import { RegistrationModule } from '@/modules/registration/registration.module';
import { PortalCatalogService } from './portal-catalog.service';
import { PortalClientService } from './portal-client.service';
import { MarketplaceEntitlementService } from './marketplace-entitlement.service';
import { PortalController } from './portal.controller';

@Module({
  imports: [ConfigurationModule, forwardRef(() => RegistrationModule)],
  controllers: [PortalController],
  providers: [PortalClientService, PortalCatalogService, MarketplaceEntitlementService],
  exports: [PortalClientService, PortalCatalogService, MarketplaceEntitlementService],
})
export class PortalModule {}
