import { Module, forwardRef } from '@nestjs/common';
import { CloudflareClientService } from './cloudflare-client.service';
import { CloudflareController } from './cloudflare.controller';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { PortalModule } from '@/core/portal/portal.module';
import { DatabaseModule } from '@/core/database/database.module';
import { DockerModule } from '../docker/docker.module';
import { AppsRepository } from '../apps/apps.repository';
import { DeviceRegistrationRepository } from '../registration/device-registration.repository';
import { CloudflareHostnameService } from './cloudflare-hostname.service';

@Module({
  imports: [ConfigurationModule, PortalModule, DatabaseModule, forwardRef(() => DockerModule)],
  controllers: [CloudflareController],
  providers: [CloudflareClientService, CloudflareHostnameService, AppsRepository, DeviceRegistrationRepository],
  exports: [CloudflareClientService],
})
export class CloudflareModule {}
