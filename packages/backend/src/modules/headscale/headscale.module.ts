import { Module } from '@nestjs/common';
import { HeadscaleController } from './headscale.controller';
import { HeadscaleService } from './headscale.service';

@Module({
  controllers: [HeadscaleController],
  providers: [HeadscaleService],
  exports: [HeadscaleService],
})
export class HeadscaleModule {}
