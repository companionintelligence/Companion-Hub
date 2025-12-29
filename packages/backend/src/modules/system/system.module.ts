import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { HostsFileService } from './hosts-file.service';

@Module({
  imports: [],
  controllers: [SystemController],
  providers: [SystemService, HostsFileService],
  exports: [HostsFileService],
})
export class SystemModule {}
