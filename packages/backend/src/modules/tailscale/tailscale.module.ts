import { LoggerModule } from '@/core/logger/logger.module';
import { Module } from '@nestjs/common';
import { TailscaleController } from './tailscale.controller';
import { TailscaleService } from './tailscale.service';

@Module({
  imports: [LoggerModule],
  controllers: [TailscaleController],
  providers: [TailscaleService],
  exports: [TailscaleService],
})
export class TailscaleModule {}
