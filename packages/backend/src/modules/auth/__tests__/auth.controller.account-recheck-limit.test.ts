/**
 * Confirming a signed-in person's own password or two-factor code is limited per account: one budget
 * across every route that asks for it, the same size and window as signing in. Only wrong answers
 * count against it.
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
import { MemoryApiKeyCheck } from '../memory-api-key.check';
import { ForwardAuthSecretResolver } from '../forward-auth-secret.resolver';
import { SessionManager } from '../session.manager';

const ACCOUNT = 7;
const OTHER_ACCOUNT = 8;
const ADDRESS = '203.0.113.9';

const req = (userId: number | null = ACCOUNT, ip = ADDRESS) =>
  ({ ip, path: '/api/auth/password', headers: {}, user: userId === null ? undefined : { id: userId } }) as unknown as Request;
const res = () => ({ status: vi.fn().mockReturnThis(), send: vi.fn(), cookie: vi.fn(), clearCookie: vi.fn() }) as unknown as Response;
const wrongPassword = () => new TranslatableError('AUTH_ERROR_INVALID_PASSWORD');
const wrongCode = () => new TranslatableError('AUTH_ERROR_TOTP_INVALID_CODE');

describe('AuthController account re-check limit', () => {
  let controller: AuthController;
  let authService: MockProxy<AuthService>;
  let logger: MockProxy<LoggerService>;
  let limiter: AuthRateLimiter;
  let clock: { now: number };

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
        { provide: MemoryApiKeyCheck, useValue: mock<MemoryApiKeyCheck>() },
        AuthRateLimiter,
      ],
    }).compile();

    controller = moduleRef.get(AuthController);
    authService = moduleRef.get(AuthService);
    logger = moduleRef.get(LoggerService);
    limiter = moduleRef.get(AuthRateLimiter);
    clock = { now: 1_000_000 };
    limiter.now = () => clock.now;
    moduleRef.get(ConfigurationService).get.mockReturnValue({ experimental: { insecureCookie: false } } as never);
    moduleRef.get(ConfigurationService).getConfig.mockReturnValue({} as never);
    authService.getCookieDomain.mockReturnValue(undefined as never);
  });

  const changePassword = (request = req()) => controller.changePassword({ currentPassword: 'x', newPassword: 'a-new-password' }, request, res());
  const changeUsername = (request = req()) => controller.changeUsername({ newUsername: 'new@example.com', password: 'x' }, request, res());
  const getTotpUri = (request = req()) => controller.getTotpUri({ password: 'x' }, request);
  const setupTotp = (request = req()) => controller.setupTotp({ code: '000000' }, request);
  const disableTotp = (request = req()) => controller.disableTotp({ password: 'x' }, request);

  /** Use up the account's budget with wrong passwords on the password route. */
  const useUpBudget = async (request = req()) => {
    authService.changePassword.mockRejectedValue(wrongPassword());
    for (let i = 0; i < 10; i++) {
      await expect(changePassword(request)).rejects.toThrow('AUTH_ERROR_INVALID_PASSWORD');
    }
  };

  const ROUTES = [
    { name: 'PATCH /auth/password', call: () => changePassword(), service: () => authService.changePassword, wrong: wrongPassword },
    { name: 'PATCH /auth/username', call: () => changeUsername(), service: () => authService.changeUsername, wrong: wrongPassword },
    { name: 'PATCH /auth/totp/get-uri', call: () => getTotpUri(), service: () => authService.getTotpUri, wrong: wrongPassword },
    { name: 'PATCH /auth/totp/setup', call: () => setupTotp(), service: () => authService.setupTotp, wrong: wrongCode },
    { name: 'PATCH /auth/totp/disable', call: () => disableTotp(), service: () => authService.disableTotp, wrong: wrongPassword },
  ];

  it.each(ROUTES)('$name answers 429 with the wait in seconds after ten wrong answers, without checking again', async ({ call, service, wrong }) => {
    service().mockRejectedValue(wrong());

    for (let i = 0; i < 10; i++) {
      await expect(call()).rejects.toThrow(wrong().message);
    }

    const refused = await call().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TranslatableError);
    expect(refused).toMatchObject({ message: 'AUTH_ERROR_RATE_LIMITED', status: HttpStatus.TOO_MANY_REQUESTS });
    expect((refused as TranslatableError).getResponse()).toEqual({ message: 'AUTH_ERROR_RATE_LIMITED', intlParams: { retryAfter: '60' } });
    expect(service()).toHaveBeenCalledTimes(10);
  });

  it('shares one budget between the routes', async () => {
    authService.changePassword.mockRejectedValue(wrongPassword());
    authService.changeUsername.mockRejectedValue(wrongPassword());
    authService.getTotpUri.mockRejectedValue(wrongPassword());

    for (let i = 0; i < 5; i++) {
      await expect(changePassword()).rejects.toThrow('AUTH_ERROR_INVALID_PASSWORD');
      await expect(changeUsername()).rejects.toThrow('AUTH_ERROR_INVALID_PASSWORD');
    }

    await expect(getTotpUri()).rejects.toThrow('AUTH_ERROR_RATE_LIMITED');
    expect(authService.getTotpUri).not.toHaveBeenCalled();
  });

  it('keeps the same budget when the address changes', async () => {
    await useUpBudget(req(ACCOUNT, '203.0.113.9'));

    await expect(changePassword(req(ACCOUNT, '198.51.100.20'))).rejects.toThrow('AUTH_ERROR_RATE_LIMITED');
  });

  it('gives each account its own budget', async () => {
    await useUpBudget(req(ACCOUNT));

    await expect(changePassword(req(OTHER_ACCOUNT))).rejects.toThrow('AUTH_ERROR_INVALID_PASSWORD');
  });

  it('does not count a correct answer or let one clear earlier wrong ones', async () => {
    authService.getTotpUri.mockRejectedValue(wrongPassword());
    for (let i = 0; i < 5; i++) {
      await expect(getTotpUri()).rejects.toThrow('AUTH_ERROR_INVALID_PASSWORD');
    }

    authService.getTotpUri.mockResolvedValueOnce({ uri: 'otpauth://x', key: 'K' });
    await getTotpUri();

    for (let i = 0; i < 5; i++) {
      await expect(getTotpUri()).rejects.toThrow('AUTH_ERROR_INVALID_PASSWORD');
    }
    await expect(getTotpUri()).rejects.toThrow('AUTH_ERROR_RATE_LIMITED');
  });

  it.each([
    ['AUTH_ERROR_INVALID_PASSWORD_LENGTH'],
    ['AUTH_ERROR_USER_ALREADY_EXISTS'],
    ['AUTH_ERROR_INVALID_USERNAME'],
    ['AUTH_ERROR_TOTP_ALREADY_ENABLED'],
    ['AUTH_ERROR_TOTP_NOT_ENABLED'],
    ['SERVER_ERROR_NOT_ALLOWED_IN_DEMO'],
  ] as const)('does not count a refusal that is not a wrong answer (%s)', async (key) => {
    authService.changePassword.mockRejectedValue(new TranslatableError(key));

    for (let i = 0; i < 30; i++) {
      await expect(changePassword()).rejects.toThrow(key);
    }

    expect(authService.changePassword).toHaveBeenCalledTimes(30);
  });

  it('does not count an unexpected error', async () => {
    authService.changePassword.mockRejectedValue(new Error('database went away'));

    for (let i = 0; i < 30; i++) {
      await expect(changePassword()).rejects.toThrow('database went away');
    }

    expect(authService.changePassword).toHaveBeenCalledTimes(30);
  });

  it('counts answers as they arrive, not as they finish', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    authService.changePassword.mockImplementation(async () => {
      await gate;
      throw wrongPassword();
    });

    const burst = Array.from({ length: 30 }, () => changePassword().catch((error: unknown) => error as Error));
    release();
    const outcomes = await Promise.all(burst);

    expect(outcomes.filter((outcome) => (outcome as Error).message === 'AUTH_ERROR_RATE_LIMITED')).toHaveLength(20);
    expect(authService.changePassword).toHaveBeenCalledTimes(10);
  });

  it('lifts the limit once the window has passed', async () => {
    await useUpBudget();
    await expect(changePassword()).rejects.toThrow('AUTH_ERROR_RATE_LIMITED');

    clock.now += 60_001;

    authService.changePassword.mockResolvedValue(true);
    await expect(changePassword()).resolves.toBeUndefined();
  });

  it('writes one warning when the limit is reached, not one per refused request', async () => {
    await useUpBudget();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 25; i++) {
      await expect(changePassword()).rejects.toThrow('AUTH_ERROR_RATE_LIMITED');
    }

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Too many wrong password or two-factor attempts on a signed-in account',
      expect.objectContaining({ userId: ACCOUNT, path: '/api/auth/password', ipAddress: ADDRESS }),
    );

    clock.now += 60_001;
    await useUpBudget();
    await expect(changePassword()).rejects.toThrow('AUTH_ERROR_RATE_LIMITED');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('warns about wrong answers that stay at the limit without being refused', async () => {
    authService.changePassword.mockRejectedValue(wrongPassword());

    // One wrong answer every six seconds, for three minutes: never refused and never under the limit for long.
    for (let i = 0; i < 30; i++) {
      await expect(changePassword()).rejects.toThrow('AUTH_ERROR_INVALID_PASSWORD');
      clock.now += 6_000;
    }

    expect(logger.warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(logger.warn.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('does not warn about a few wrong answers', async () => {
    authService.changePassword.mockRejectedValue(wrongPassword());

    for (let i = 0; i < 9; i++) {
      await expect(changePassword()).rejects.toThrow('AUTH_ERROR_INVALID_PASSWORD');
    }

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('leaves the budget alone for a request with no signed-in person', async () => {
    const admit = vi.spyOn(limiter, 'admit');

    await expect(changePassword(req(null))).rejects.toThrow('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');

    expect(admit).not.toHaveBeenCalled();
    expect(authService.changePassword).not.toHaveBeenCalled();
  });
});
