import { LoggerModule } from '@/core/logger/logger.module';
import { Module } from '@nestjs/common';
import { TailscaleController } from './tailscale.controller';
import { TailscaleService } from './tailscale.service';
import { TailscaleAdminApiService } from './tailscale-admin-api.service';

@Module({
  imports: [LoggerModule],
  controllers: [TailscaleController],
  providers: [TailscaleService, TailscaleAdminApiService],
  exports: [TailscaleService, TailscaleAdminApiService],
})
export class TailscaleModule {}
