import { Module, forwardRef } from '@nestjs/common';
import { CloudflareClientService } from './cloudflare-client.service';
import { CloudflareController } from './cloudflare.controller';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { DockerModule } from '../docker/docker.module';
import { CustomDomainsModule } from '../custom-domains/custom-domains.module';

@Module({
  imports: [ConfigurationModule, forwardRef(() => DockerModule), forwardRef(() => CustomDomainsModule)],
  controllers: [CloudflareController],
  providers: [CloudflareClientService],
  exports: [CloudflareClientService],
})
export class CloudflareModule {}
