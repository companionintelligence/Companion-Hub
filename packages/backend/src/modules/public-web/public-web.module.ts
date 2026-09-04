import { Module, forwardRef } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { AppLifecycleModule } from '../app-lifecycle/app-lifecycle.module';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { PortalModule } from '@/core/portal/portal.module';
import { EnvModule } from '../env/env.module';
import { RegistrationModule } from '../registration/registration.module';
import { PublicWebController } from './public-web.controller';
import { PublicWebService } from './public-web.service';

@Module({
  imports: [ConfigurationModule, PortalModule, EnvModule, RegistrationModule, AppsModule, forwardRef(() => AppLifecycleModule)],
  controllers: [PublicWebController],
  providers: [PublicWebService],
  exports: [PublicWebService],
})
export class PublicWebModule {}
