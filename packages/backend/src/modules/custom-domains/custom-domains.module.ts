import { Module } from '@nestjs/common';
import { CustomDomainsController } from './custom-domains.controller';
import { CustomDomainsService } from './custom-domains.service';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { RegistrationModule } from '../registration/registration.module';
import { SSEModule } from '@/core/sse/sse.module';

@Module({
  imports: [ConfigurationModule, RegistrationModule, SSEModule],
  controllers: [CustomDomainsController],
  providers: [CustomDomainsService],
  exports: [CustomDomainsService],
})
export class CustomDomainsModule {}
