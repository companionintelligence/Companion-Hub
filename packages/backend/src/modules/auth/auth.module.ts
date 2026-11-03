import { ApiKeyModule } from '@/modules/api-keys/api-key.module';
import { AppsModule } from '@/modules/apps/apps.module';
import { EnvModule } from '@/modules/env/env.module';
import { EncryptionModule } from '@/core/encryption/encryption.module';
import { PasswordModule } from '@/core/password/password.module';
import { PortalModule } from '@/core/portal/portal.module';
import { RegistrationModule } from '@/modules/registration/registration.module';
import { UserModule } from '@/modules/user/user.module';
import { Module, forwardRef } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { OobiController } from './oobi.controller';
import { AuthRateLimiter } from './auth-rate-limiter';
import { AuthService } from './auth.service';
import { ForwardAuthIdentityResolver } from './forward-auth-identity.resolver';
import { ForwardAuthSecretResolver } from './forward-auth-secret.resolver';
import { BearerOrgMembershipCache } from './bearer-org-membership.cache';
import { MemoryApiKeyCheck } from './memory-api-key.check';
import { MemoryProviderResolver } from '@/modules/memory-connect/memory-provider.resolver';
import { SessionManager } from './session.manager';

@Module({
  // AppsModule/EnvModule feed the per-app forward-auth signing resolver (host → app → app.env
  // secret). Cycle-safe: no module imports AuthModule (AuthGuard is consumed as a bare class).
  // SessionUserCache is provided by the global CacheModule — declaring it here too would mint a
  // second instance, so writes invalidated on one would still be served stale by the other.
  imports: [UserModule, EncryptionModule, PasswordModule, RegistrationModule, forwardRef(() => PortalModule), AppsModule, EnvModule, ApiKeyModule],
  controllers: [AuthController, OobiController],
  // MemoryProviderResolver is stateless (it reads the installed apps each call), so a second
  // instance here is safe, and it spares AuthModule importing MemoryConnectModule and its graph.
  providers: [
    AuthService,
    AuthRateLimiter,
    SessionManager,
    ForwardAuthSecretResolver,
    ForwardAuthIdentityResolver,
    BearerOrgMembershipCache,
    MemoryProviderResolver,
    MemoryApiKeyCheck,
  ],
  exports: [AuthService, SessionManager, BearerOrgMembershipCache],
})
export class AuthModule {}
