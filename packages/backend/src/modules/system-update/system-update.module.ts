import { Module } from '@nestjs/common';
import { SystemUpdateService } from './system-update.service';
import { SystemUpdateController } from './system-update.controller';
import { RegistryModule } from '@/utils/registry/registry.module';

@Module({
  imports: [RegistryModule],
  controllers: [SystemUpdateController],
  providers: [SystemUpdateService],
  exports: [SystemUpdateService],
})
export class SystemUpdateModule {}
