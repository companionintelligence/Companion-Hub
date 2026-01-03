import { Module } from '@nestjs/common';
import { CloudflareTunnelService } from './cloudflare-tunnel.service';
import { CloudflareController } from './cloudflare.controller';
import { ConfigurationModule } from '@/core/config/configuration.module';

@Module({
  imports: [ConfigurationModule],
  controllers: [CloudflareController],
  providers: [CloudflareTunnelService],
  exports: [CloudflareTunnelService],
})
export class CloudflareModule {}
