import { AppsModule } from '@/modules/apps/apps.module';
import { EnvModule } from '@/modules/env/env.module';
import { EncryptionModule } from '@/core/encryption/encryption.module';
import { PasswordModule } from '@/core/password/password.module';
import { PortalModule } from '@/core/portal/portal.module';
import { RegistrationModule } from '@/modules/registration/registration.module';
import { UserModule } from '@/modules/user/user.module';
import { Module, forwardRef } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ForwardAuthSecretResolver } from './forward-auth-secret.resolver';
import { SessionManager } from './session.manager';

@Module({
  // AppsModule/EnvModule feed the per-app forward-auth signing resolver (host → app → app.env
  // secret). Cycle-safe: no module imports AuthModule (AuthGuard is consumed as a bare class).
  // SessionUserCache is provided by the global CacheModule — declaring it here too would mint a
  // second instance, so writes invalidated on one would still be served stale by the other.
  imports: [UserModule, EncryptionModule, PasswordModule, RegistrationModule, forwardRef(() => PortalModule), AppsModule, EnvModule],
  controllers: [AuthController],
  providers: [AuthService, SessionManager, ForwardAuthSecretResolver],
  exports: [SessionManager],
})
export class AuthModule {}
