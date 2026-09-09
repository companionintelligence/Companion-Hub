import { Module, forwardRef } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationGuard } from './registration.guard';
import { RegistrationService } from './registration.service';
import { DeviceRegistrationRepository } from './device-registration.repository';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { LoggerModule } from '@/core/logger/logger.module';
import { DatabaseModule } from '@/core/database/database.module';
import { PortalModule } from '@/core/portal/portal.module';
import { CloudflareModule } from '../cloudflare/cloudflare.module';
import { DockerModule } from '../docker/docker.module';
import { QueueModule } from '../queue/queue.module';
import { TailscaleModule } from '../tailscale/tailscale.module';

@Module({
  imports: [
    ConfigurationModule,
    LoggerModule,
    DatabaseModule,
    forwardRef(() => PortalModule),
    forwardRef(() => CloudflareModule),
    forwardRef(() => DockerModule),
    QueueModule,
    TailscaleModule,
  ],
  controllers: [RegistrationController],
  providers: [RegistrationService, RegistrationGuard, DeviceRegistrationRepository],
  exports: [RegistrationService, RegistrationGuard, DeviceRegistrationRepository],
})
export class RegistrationModule {}
