import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { SessionUserCache } from './session-user.cache';

@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [CacheService, SessionUserCache],
  exports: [CacheService, SessionUserCache],
})
export class CacheModule {}
