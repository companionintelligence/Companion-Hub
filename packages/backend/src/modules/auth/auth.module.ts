import { EncryptionModule } from '@/core/encryption/encryption.module';
import { PasswordModule } from '@/core/password/password.module';
import { UserModule } from '@/modules/user/user.module';
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { PortalController } from './portal.controller';
import { AuthService } from './auth.service';
import { SessionManager } from './session.manager';

@Module({
  imports: [UserModule, EncryptionModule, PasswordModule],
  controllers: [AuthController, PortalController],
  providers: [AuthService, SessionManager],
})
export class AuthModule {}
