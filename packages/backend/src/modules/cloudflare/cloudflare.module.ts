import { Module } from '@nestjs/common';
import { CloudflareTunnelService } from './cloudflare-tunnel.service';
import { ConfigurationModule } from '@/core/config/configuration.module';

@Module({
  imports: [ConfigurationModule],
  providers: [CloudflareTunnelService],
  exports: [CloudflareTunnelService],
})
export class CloudflareModule {}

