import { Module, forwardRef } from '@nestjs/common';
import { PortalModule } from '@/core/portal/portal.module';
import { AppsModule } from '../apps/apps.module';
import { UserConfigController } from './user-config.controller';
import { UserConfigService } from './user-config.service';

@Module({
  // UserConfigService reads via AppsReadService; no AppLifecycle coupling. PortalModule gives the
  // controller the grant check its routes assert.
  imports: [forwardRef(() => AppsModule), forwardRef(() => PortalModule)],
  controllers: [UserConfigController],
  providers: [UserConfigService],
  exports: [UserConfigService],
})
export class UserConfigModule {}
