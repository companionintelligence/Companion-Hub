import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { SystemUpdateService } from './system-update.service';
import { SystemUpdateController } from './system-update.controller';
import { DesktopReleaseService } from './desktop-release.service';
import { RegistryModule } from '@/utils/registry/registry.module';

@Module({
  imports: [HttpModule, RegistryModule],
  controllers: [SystemUpdateController],
  providers: [SystemUpdateService, DesktopReleaseService],
  exports: [SystemUpdateService],
})
export class SystemUpdateModule {}
