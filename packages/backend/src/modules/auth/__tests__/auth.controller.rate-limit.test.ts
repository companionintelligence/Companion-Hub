/**
 * The unauthenticated auth routes can be guessed at, spammed, or used to send mail. Each is limited
 * per client address (see AuthRateLimiter), and the request-file password reset only answers the
 * callers that are on the box.
 */
import { HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { TranslatableError } from '@/common/error/translatable-error';
import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { UserRepository } from '@/modules/user/user.repository';
import { AuthController } from '../auth.controller';
import { AuthRateLimiter } from '../auth-rate-limiter';
import { AuthService } from '../auth.service';
import { BearerOrgMembershipCache } from '../bearer-org-membership.cache';
import { ForwardAuthIdentityResolver } from '../forward-auth-identity.resolver';
import { ForwardAuthSecretResolver } from '../forward-auth-secret.resolver';
import { SessionManager } from '../session.manager';

const req = (ip: string, extra: Record<string, unknown> = {}) => ({ ip, headers: {}, ...extra }) as unknown as Request;
const res = () => ({ cookie: vi.fn() }) as unknown as Response;
const wrongCredentials = () => new TranslatableError('AUTH_ERROR_INVALID_CREDENTIALS', {}, HttpStatus.BAD_REQUEST);

describe('AuthController rate limiting', () => {
  let controller: AuthController;
  let authService: MockProxy<AuthService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mock<AuthService>() },
        { provide: ForwardAuthSecretResolver, useValue: mock<ForwardAuthSecretResolver>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: CacheService, useValue: mock<CacheService>() },
        { provide: UserRepository, useValue: mock<UserRepository>() },
        { provide: SessionManager, useValue: mock<SessionManager>() },
        { provide: RegistrationService, useValue: mock<RegistrationService>() },
        { provide: DeviceRegistrationRepository, useValue: mock<DeviceRegistrationRepository>() },
        { provide: BearerOrgMembershipCache, useValue: mock<BearerOrgMembershipCache>() },
        { provide: SessionUserCache, useValue: mock<SessionUserCache>() },
        { provide: ForwardAuthIdentityResolver, useValue: mock<ForwardAuthIdentityResolver>() },
        AuthRateLimiter,
      ],
    }).compile();

    controller = moduleRef.get(AuthController);
    authService = moduleRef.get(AuthService);
    moduleRef.get(ConfigurationService).get.mockReturnValue({ experimental: { insecureCookie: false } } as never);
    moduleRef.get(ConfigurationService).getConfig.mockReturnValue({} as never);
  });

  describe('POST /auth/login', () => {
    it('stops answering a client that keeps getting the password wrong, without asking the service again', async () => {
      authService.login.mockRejectedValue(wrongCredentials());

      for (let i = 0; i < 10; i++) {
        await expect(controller.login({ username: 'op', password: `guess-${i}` } as never, res(), req('203.0.113.9'))).rejects.toThrow(
          'AUTH_ERROR_INVALID_CREDENTIALS',
        );
      }
      await expect(controller.login({ username: 'op', password: 'guess-11' } as never, res(), req('203.0.113.9'))).rejects.toMatchObject({
        message: 'AUTH_ERROR_RATE_LIMITED',
        status: HttpStatus.TOO_MANY_REQUESTS,
      });

      expect(authService.login).toHaveBeenCalledTimes(10);
    });

    it('does not limit someone who signs in successfully, however often', async () => {
      authService.login.mockResolvedValue({ sessionId: 'sid' } as never);
      authService.getCookieDomain.mockReturnValue(undefined as never);

      for (let i = 0; i < 40; i++) {
        await controller.login({ username: 'op', password: 'right' } as never, res(), req('203.0.113.9'));
      }

      expect(authService.login).toHaveBeenCalledTimes(40);
    });

    it('lets a client who failed a few times in, and does not let a success reset the count', async () => {
      authService.getCookieDomain.mockReturnValue(undefined as never);
      authService.login.mockRejectedValue(wrongCredentials());
      for (let i = 0; i < 9; i++) {
        await expect(controller.login({ username: 'op', password: 'x' } as never, res(), req('203.0.113.9'))).rejects.toThrow();
      }
      authService.login.mockResolvedValue({ sessionId: 'sid' } as never);
      await controller.login({ username: 'op', password: 'right' } as never, res(), req('203.0.113.9'));

      authService.login.mockRejectedValue(wrongCredentials());
      await expect(controller.login({ username: 'op', password: 'x' } as never, res(), req('203.0.113.9'))).rejects.toThrow(
        'AUTH_ERROR_INVALID_CREDENTIALS',
      );
      await expect(controller.login({ username: 'op', password: 'x' } as never, res(), req('203.0.113.9'))).rejects.toThrow(
        'AUTH_ERROR_RATE_LIMITED',
      );
    });

    it('counts parallel guesses as they arrive, not as they finish', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      authService.login.mockImplementation(async () => {
        await gate;
        throw wrongCredentials();
      });

      const burst = Array.from({ length: 300 }, () => controller.login({ username: 'op', password: 'x' } as never, res(), req('203.0.113.9')));
      release();
      const outcomes = await Promise.allSettled(burst);

      expect(authService.login).toHaveBeenCalledTimes(10);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected' && /RATE_LIMITED/.test(String(outcome.reason?.message)))).toHaveLength(290);
    });

    it('limits every address of one IPv6 /64 together', async () => {
      authService.login.mockRejectedValue(wrongCredentials());

      for (let i = 0; i < 10; i++) {
        await expect(controller.login({ username: 'op', password: 'x' } as never, res(), req(`2001:db8:1:2::${i + 1}`))).rejects.toThrow(
          'AUTH_ERROR_INVALID_CREDENTIALS',
        );
      }

      await expect(controller.login({ username: 'op', password: 'x' } as never, res(), req('2001:db8:1:2:ffff::9'))).rejects.toThrow(
        'AUTH_ERROR_RATE_LIMITED',
      );
    });

    it("never lets one client's failures lock out another", async () => {
      authService.login.mockRejectedValue(wrongCredentials());
      for (let i = 0; i < 12; i++) {
        await expect(controller.login({ username: 'op', password: 'x' } as never, res(), req('198.51.100.66'))).rejects.toThrow();
      }

      authService.getCookieDomain.mockReturnValue(undefined as never);
      authService.login.mockResolvedValue({ sessionId: 'sid' } as never);

      await expect(controller.login({ username: 'op', password: 'right' } as never, res(), req('203.0.113.9'))).resolves.toBeDefined();
    });
  });

  describe('POST /auth/verify-totp', () => {
    it('stops answering a client that keeps getting the code wrong', async () => {
      authService.verifyTotp.mockRejectedValue(new TranslatableError('AUTH_ERROR_TOTP_INVALID_CODE'));

      for (let i = 0; i < 10; i++) {
        await expect(controller.verifyTotp({ totpSessionId: 's', totpCode: '000000' } as never, res(), req('203.0.113.9'))).rejects.toThrow(
          'AUTH_ERROR_TOTP_INVALID_CODE',
        );
      }
      await expect(controller.verifyTotp({ totpSessionId: 's', totpCode: '000000' } as never, res(), req('203.0.113.9'))).rejects.toThrow(
        'AUTH_ERROR_RATE_LIMITED',
      );
    });
  });

  describe('POST /auth/register', () => {
    it('allows a handful of sign-ups a minute from one client and then refuses', async () => {
      authService.register.mockResolvedValue({ requiresEmailVerification: true } as never);

      for (let i = 0; i < 5; i++) {
        await controller.register({ username: `u${i}@example.com`, password: 'pw' } as never, res(), req('203.0.113.9'));
      }
      await expect(controller.register({ username: 'u6@example.com', password: 'pw' } as never, res(), req('203.0.113.9'))).rejects.toThrow(
        'AUTH_ERROR_RATE_LIMITED',
      );

      expect(authService.register).toHaveBeenCalledTimes(5);
    });
  });

  describe('POST /auth/password-reset/request', () => {
    it('limits how many reset emails one client can ask for', async () => {
      authService.requestPasswordReset.mockResolvedValue(undefined as never);
      const caller = req('203.0.113.9', { get: vi.fn(), protocol: 'https' });

      for (let i = 0; i < 5; i++) {
        await controller.requestPasswordReset({ email: `a${i}@example.com`, deviceId: 'dev' } as never, caller);
      }
      await expect(controller.requestPasswordReset({ email: 'a6@example.com', deviceId: 'dev' } as never, caller)).rejects.toThrow(
        'AUTH_ERROR_RATE_LIMITED',
      );

      expect(authService.requestPasswordReset).toHaveBeenCalledTimes(5);
    });
  });

  describe('POST /auth/password-reset/complete', () => {
    it('stops answering a client that keeps presenting bad tokens', async () => {
      authService.completePasswordReset.mockRejectedValue(new TranslatableError('AUTH_ERROR_INVALID_CREDENTIALS', {}, HttpStatus.BAD_REQUEST));

      for (let i = 0; i < 10; i++) {
        await expect(controller.completePasswordReset({ token: `t${i}`, newPassword: 'pw' } as never, req('203.0.113.9'))).rejects.toThrow(
          'AUTH_ERROR_INVALID_CREDENTIALS',
        );
      }
      await expect(controller.completePasswordReset({ token: 't11', newPassword: 'pw' } as never, req('203.0.113.9'))).rejects.toThrow(
        'AUTH_ERROR_RATE_LIMITED',
      );
    });
  });

  describe('the request-file password reset', () => {
    const asPrincipal = (hubPrincipal: string) => req('203.0.113.9', { hubPrincipal, user: { id: 1 } });

    it.each(['session', 'portal-device', 'qa-read', undefined as unknown as string])(
      'refuses a %s caller on every verb, without touching the password',
      async (principal) => {
        const caller = asPrincipal(principal);

        await expect(controller.resetPassword({ newPassword: 'attacker-chosen' } as never, caller)).rejects.toMatchObject({
          status: HttpStatus.FORBIDDEN,
        });
        await expect(controller.cancelResetPassword(caller)).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
        await expect(controller.checkResetPasswordRequest(caller)).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });

        expect(authService.changeOperatorPassword).not.toHaveBeenCalled();
        expect(authService.cancelPasswordChangeRequest).not.toHaveBeenCalled();
        expect(authService.checkPasswordChangeRequest).not.toHaveBeenCalled();
      },
    );

    it.each(['cli', 'host-local'])('still answers a %s caller', async (principal) => {
      authService.changeOperatorPassword.mockResolvedValue({ email: 'op@example.com' });
      authService.checkPasswordChangeRequest.mockResolvedValue(true);

      await expect(controller.resetPassword({ newPassword: 'chosen-by-the-owner' } as never, asPrincipal(principal))).resolves.toMatchObject({
        success: true,
      });
      await expect(controller.checkResetPasswordRequest(asPrincipal(principal))).resolves.toMatchObject({ isRequestPending: true });
    });
  });
});
