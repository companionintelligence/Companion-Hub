import { LoggerModule } from '@/core/logger/logger.module';
import { Module } from '@nestjs/common';
import { TailscaleController } from './tailscale.controller';
import { TailscaleService } from './tailscale.service';
import { TailscaleAdminApiService } from './tailscale-admin-api.service';
import { TailscaleServicesService } from './tailscale-services.service';

@Module({
  imports: [LoggerModule],
  controllers: [TailscaleController],
  providers: [TailscaleService, TailscaleAdminApiService, TailscaleServicesService],
  exports: [TailscaleService, TailscaleAdminApiService, TailscaleServicesService],
})
export class TailscaleModule {}
