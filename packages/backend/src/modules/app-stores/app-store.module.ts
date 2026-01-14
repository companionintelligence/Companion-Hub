import { Module, forwardRef } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { AppStoreRepository } from './app-store.repository';
import { AppStoreService } from './app-store.service';
import { ReposHelpers } from './repos.helpers';
import { RegistrationModule } from '../registration/registration.module';

@Module({
  imports: [QueueModule, forwardRef(() => RegistrationModule)],
  controllers: [],
  providers: [AppStoreService, AppStoreRepository, ReposHelpers],
  exports: [AppStoreService, ReposHelpers, AppStoreRepository],
})
export class AppStoreModule {}
