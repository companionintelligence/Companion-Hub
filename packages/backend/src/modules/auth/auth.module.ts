import { EncryptionModule } from '@/core/encryption/encryption.module';
import { PasswordModule } from '@/core/password/password.module';
import { RegistrationModule } from '@/modules/registration/registration.module';
import { UserModule } from '@/modules/user/user.module';
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionManager } from './session.manager';

@Module({
  imports: [UserModule, EncryptionModule, PasswordModule, RegistrationModule],
  controllers: [AuthController],
  providers: [AuthService, SessionManager],
  exports: [SessionManager],
})
export class AuthModule {}
