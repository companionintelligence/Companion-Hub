import { Module, forwardRef } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationGuard } from './registration.guard';
import { RegistrationService } from './registration.service';
import { OrganizationRepository } from './organization.repository';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { LoggerModule } from '@/core/logger/logger.module';
import { DatabaseModule } from '@/core/database/database.module';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [ConfigurationModule, LoggerModule, DatabaseModule, forwardRef(() => CloudflareModule), QueueModule],
  controllers: [RegistrationController],
  providers: [RegistrationService, RegistrationGuard, OrganizationRepository],
  exports: [RegistrationService, RegistrationGuard, OrganizationRepository],
})
export class RegistrationModule {}
