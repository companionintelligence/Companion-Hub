import { Module } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { RegistrationRepository } from './registration.repository';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { LoggerModule } from '@/core/logger/logger.module';

@Module({
  imports: [ConfigurationModule, LoggerModule],
  controllers: [RegistrationController],
  providers: [RegistrationService, RegistrationRepository],
  exports: [RegistrationService],
})
export class RegistrationModule {}
