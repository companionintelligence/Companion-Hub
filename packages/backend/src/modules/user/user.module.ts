import { CacheModule } from '@/core/cache/cache.module';
import { Module } from '@nestjs/common';
import { FederatedIdentityRepository } from './federated-identity.repository';
import { UserRepository } from './user.repository';

@Module({
  // CacheModule is @Global, so this import is not what makes SessionUserCache resolvable — it is
  // what keeps UserModule compilable on its own, instead of only inside a graph that happens to
  // have pulled CacheModule in already.
  imports: [CacheModule],
  controllers: [],
  providers: [UserRepository, FederatedIdentityRepository],
  exports: [UserRepository, FederatedIdentityRepository],
})
export class UserModule {}
