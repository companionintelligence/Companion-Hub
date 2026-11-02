import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { LoggerModule } from '@/core/logger/logger.module';
import { PortalModule } from '@/core/portal/portal.module';
import { RegistryService } from './registry.service';

@Module({
  // forwardRef as in AppsModule: PortalModule and RegistrationModule import each other.
  imports: [HttpModule, ConfigurationModule, LoggerModule, forwardRef(() => PortalModule)],
  providers: [RegistryService],
  exports: [RegistryService],
})
export class RegistryModule {}
