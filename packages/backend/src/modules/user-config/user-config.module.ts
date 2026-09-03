import { Module, forwardRef } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { UserConfigController } from './user-config.controller';
import { UserConfigService } from './user-config.service';

@Module({
  // AppsModule only — UserConfigService reads via AppsReadService; no AppLifecycle coupling.
  imports: [forwardRef(() => AppsModule)],
  controllers: [UserConfigController],
  providers: [UserConfigService],
  exports: [UserConfigService],
})
export class UserConfigModule {}
