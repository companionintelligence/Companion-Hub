import { Module } from '@nestjs/common';
import { FederatedIdentityRepository } from './federated-identity.repository';
import { UserRepository } from './user.repository';

@Module({
  imports: [],
  controllers: [],
  providers: [UserRepository, FederatedIdentityRepository],
  exports: [UserRepository, FederatedIdentityRepository],
})
export class UserModule {}
