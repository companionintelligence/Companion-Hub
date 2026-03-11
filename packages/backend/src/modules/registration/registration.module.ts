import { Module, forwardRef } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationGuard } from './registration.guard';
import { RegistrationService } from './registration.service';
import { DeviceRegistrationRepository } from './device-registration.repository';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { LoggerModule } from '@/core/logger/logger.module';
import { DatabaseModule } from '@/core/database/database.module';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { DockerModule } from '../docker/docker.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [ConfigurationModule, LoggerModule, DatabaseModule, forwardRef(() => CloudflareModule), forwardRef(() => DockerModule), QueueModule],
  controllers: [RegistrationController],
  providers: [RegistrationService, RegistrationGuard, DeviceRegistrationRepository],
  exports: [RegistrationService, RegistrationGuard, DeviceRegistrationRepository],
})
export class RegistrationModule {}
