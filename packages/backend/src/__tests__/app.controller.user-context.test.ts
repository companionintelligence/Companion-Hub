import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Request } from 'express';
import { AppController } from '../app.controller';
import type { AppService } from '../app.service';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { UserRepository } from '@/modules/user/user.repository';
import type { LoggerService } from '@/core/logger/logger.service';
import type { SessionManager } from '@/modules/auth/session.manager';
import { DID_AUTH_FLAG } from '@/modules/auth/did-auth.service';
import { KERI_OOBI_FLAG } from '@/modules/auth/keri-oobi.guard';

describe('AppController.userContext protocol flags', () => {
  const savedEnv = {
    [DID_AUTH_FLAG]: process.env[DID_AUTH_FLAG],
    [KERI_OOBI_FLAG]: process.env[KERI_OOBI_FLAG],
    CI_HUB_ALLOW_CLOUD_FALLBACK: process.env.CI_HUB_ALLOW_CLOUD_FALLBACK,
  };

  let controller: AppController;
  let configuration: ReturnType<typeof mock<ConfigurationService>>;
  let userRepository: ReturnType<typeof mock<UserRepository>>;
  let appService: ReturnType<typeof mock<AppService>>;

  const unused = <T>() => ({}) as T;

  beforeEach(() => {
    delete process.env[DID_AUTH_FLAG];
    delete process.env[KERI_OOBI_FLAG];
    delete process.env.CI_HUB_ALLOW_CLOUD_FALLBACK;

    configuration = mock<ConfigurationService>();
    userRepository = mock<UserRepository>();
    appService = mock<AppService>();

    configuration.get.mockImplementation((key: string) => {
      if (key === 'localDomain') return 'localhost';
      if (key === 'domain') return '';
      if (key === 'userSettings') return { sslPort: 443, guestDashboard: false, disablePasswordReset: true, themeColor: 'blue' };
      return undefined as never;
    });
    userRepository.getFirstOperator.mockResolvedValue({ id: 1 } as never);
    appService.peekLocalVersion.mockReturnValue({ current: '1.0.0', latest: '1.0.0', body: '', releases: [] });

    const sessionManager = mock<SessionManager>();
    const logger = mock<LoggerService>();

    controller = new AppController(
      appService,
      userRepository,
      configuration,
      unused(),
      logger,
      unused(),
      unused(),
      unused(),
      unused(),
      sessionManager,
      unused(),
      unused(),
    );
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('exposes only didAuthEnabled when unauthenticated and hides internal KERI/cloud policy flags', async () => {
    process.env[DID_AUTH_FLAG] = 'true';
    process.env[KERI_OOBI_FLAG] = 'true';
    process.env.CI_HUB_ALLOW_CLOUD_FALLBACK = 'true';

    const ctx = await controller.userContext({ cookies: {}, get: () => undefined } as unknown as Request);

    expect(ctx.isLoggedIn).toBe(false);
    expect(ctx.didAuthEnabled).toBe(true);
    expect(ctx).not.toHaveProperty('keriOobiEnabled');
    expect(ctx).not.toHaveProperty('allowCloudFallback');
  });

  it('exposes didAuthEnabled, keriOobiEnabled, and allowCloudFallback when authenticated', async () => {
    process.env[DID_AUTH_FLAG] = 'false';
    process.env[KERI_OOBI_FLAG] = 'true';
    process.env.CI_HUB_ALLOW_CLOUD_FALLBACK = 'true';

    const ctx = await controller.userContext({ user: { id: 1 }, cookies: {}, get: () => undefined } as unknown as Request);

    expect(ctx.isLoggedIn).toBe(true);
    expect(ctx.didAuthEnabled).toBe(false);
    expect(ctx.keriOobiEnabled).toBe(true);
    expect(ctx.allowCloudFallback).toBe(true);
  });
});
