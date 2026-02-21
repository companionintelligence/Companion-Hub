import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { SystemInspectorController } from './system-inspector.controller';
import { SystemInspectorService } from './system-inspector.service';
import { NetworkModule } from '../network/network.module';
import { DockerModule } from '../docker/docker.module';

@Module({
  imports: [NetworkModule, DockerModule],
  controllers: [SystemController, SystemInspectorController],
  providers: [SystemService, SystemInspectorService],
  exports: [SystemInspectorService],
})
export class SystemModule {}
