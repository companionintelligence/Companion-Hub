import { Module, forwardRef } from '@nestjs/common';
import { EnvModule } from '../env/env.module';
import { CustomAppController } from './custom-apps.controller';
import { CustomAppService } from './custom-apps.service';
import { PortExposeService } from './port-expose.service';
import { AppsModule } from '../apps/apps.module';
import { AppLifecycleModule } from '../app-lifecycle/app-lifecycle.module';
import { DockerModule } from '../docker/docker.module';
import { RegistrationModule } from '../registration/registration.module';
import { PortalModule } from '@/core/portal/portal.module';

@Module({
  imports: [EnvModule, AppsModule, DockerModule, RegistrationModule, PortalModule, forwardRef(() => AppLifecycleModule)],
  controllers: [CustomAppController],
  providers: [CustomAppService, PortExposeService],
  exports: [CustomAppService, PortExposeService],
})
export class CustomAppsModule {}
