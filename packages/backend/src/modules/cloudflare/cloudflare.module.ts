import { Module } from '@nestjs/common';
import { CloudflareClientService } from './cloudflare-client.service';
import { CloudflareController } from './cloudflare.controller';
import { ConfigurationModule } from '@/core/config/configuration.module';

@Module({
  imports: [ConfigurationModule],
  controllers: [CloudflareController],
  providers: [CloudflareClientService],
  exports: [CloudflareClientService],
})
export class CloudflareModule {}
