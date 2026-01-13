import { Module, forwardRef } from '@nestjs/common';
import { CloudflareClientService } from './cloudflare-client.service';
import { CloudflareController } from './cloudflare.controller';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { DockerModule } from '../docker/docker.module';

@Module({
  imports: [ConfigurationModule, forwardRef(() => DockerModule)],
  controllers: [CloudflareController],
  providers: [CloudflareClientService],
  exports: [CloudflareClientService],
})
export class CloudflareModule {}
