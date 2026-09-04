import { Module, forwardRef } from '@nestjs/common';
import { ConfigurationModule } from '../config/configuration.module';
import { RegistrationModule } from '@/modules/registration/registration.module';
import { UserModule } from '@/modules/user/user.module';
import { PortalCatalogService } from './portal-catalog.service';
import { PortalClientService } from './portal-client.service';
import { MarketplaceEntitlementService } from './marketplace-entitlement.service';
import { MarketplaceWhoIsService } from './marketplace-whois.service';
import { PortalController } from './portal.controller';

@Module({
  imports: [ConfigurationModule, forwardRef(() => RegistrationModule), UserModule],
  controllers: [PortalController],
  providers: [PortalClientService, PortalCatalogService, MarketplaceEntitlementService, MarketplaceWhoIsService],
  exports: [PortalClientService, PortalCatalogService, MarketplaceEntitlementService, MarketplaceWhoIsService],
})
export class PortalModule {}
