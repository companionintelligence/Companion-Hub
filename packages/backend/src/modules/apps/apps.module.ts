import { ConfigurationService } from '@/core/config/configuration.service';
import { Module, forwardRef } from '@nestjs/common';
import { EnvModule } from '../env/env.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { QueueModule } from '../queue/queue.module';
import { AppFilesManager } from './app-files-manager';
import { AppHelpers } from './app.helpers';
import { AppsController } from './apps.controller';
import { AppsRepository } from './apps.repository';
import { AppsService } from './apps.service';
import { RegistrationModule } from '../registration/registration.module';

@Module({
  imports: [QueueModule, EnvModule, MarketplaceModule, forwardRef(() => RegistrationModule)],
  controllers: [AppsController],
  providers: [AppFilesManager, AppsRepository, AppHelpers, AppsService, ConfigurationService],
  exports: [AppsRepository, AppFilesManager, AppHelpers, AppsService],
})
export class AppsModule {}
