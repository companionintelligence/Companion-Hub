import { Module } from '@nestjs/common';
import { HeadscaleController } from './headscale.controller';
import { HeadscaleService } from './headscale.service';
import { DockerModule } from '../docker/docker.module';

@Module({
  imports: [DockerModule],
  controllers: [HeadscaleController],
  providers: [HeadscaleService],
  exports: [HeadscaleService],
})
export class HeadscaleModule {}
