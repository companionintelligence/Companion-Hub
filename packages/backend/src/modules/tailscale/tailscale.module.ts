import { Module } from '@nestjs/common';
import { TailscaleController } from './tailscale.controller';
import { TailscaleService } from './tailscale.service';

@Module({
  controllers: [TailscaleController],
  providers: [TailscaleService],
  exports: [TailscaleService],
})
export class TailscaleModule {}
