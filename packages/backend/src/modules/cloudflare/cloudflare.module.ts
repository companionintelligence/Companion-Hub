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
import { TunnelHealthService } from './tunnel-health.service';

@Module({
  imports: [ConfigurationModule, forwardRef(() => PortalModule), DatabaseModule, forwardRef(() => DockerModule)],
  controllers: [CloudflareController],
  providers: [CloudflareClientService, CloudflareHostnameService, TunnelHealthService, AppsRepository, DeviceRegistrationRepository],
  // TunnelHealthService is exported for MemoryConnectModule, which gates the
  // connect launcher on whether the Hub's public origin actually works.
  exports: [CloudflareClientService, TunnelHealthService],
})
export class CloudflareModule {}
