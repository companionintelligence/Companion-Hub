/**
 * Sign in with a DID, at the controller: the flag, the link-first rule, and the one answer to every
 * refusal. The proof itself (alg, audience, nonce, signature) is `did-auth.service.test.ts`.
 */
import { ConflictException, ForbiddenException, HttpStatus, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { UserRepository } from '@/modules/user/user.repository';
import { AuthController } from '../auth.controller';
import { AuthGuard } from '../auth.guard';
import { AuthRateLimiter } from '../auth-rate-limiter';
import { AuthService } from '../auth.service';
import { BearerOrgMembershipCache } from '../bearer-org-membership.cache';
import { DidAuthFlagGuard } from '../did-auth.guard';
import { DID_AUTH_FLAG, DidAuthRefusal, type DidAuthRefusalReason, DidAuthService } from '../did-auth.service';
import { ForwardAuthIdentityResolver } from '../forward-auth-identity.resolver';
import { ForwardAuthSecretResolver } from '../forward-auth-secret.resolver';
import { MemoryApiKeyCheck } from '../memory-api-key.check';
import { SessionManager } from '../session.manager';

const DID = 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw';
const PROOF = { challengeId: '11111111-2222-4333-8444-555555555555', idToken: 'a.b.c' };
const ACTIVE = { id: 7, username: 'op@example.com', totpEnabled: false, accessStatus: 'active' };

interface RequestOverrides {
  ip?: string;
  hubPrincipal?: string;
  user?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

const req = (overrides: RequestOverrides = {}) =>
  ({ ip: '203.0.113.9', headers: {}, cookies: {}, hubPrincipal: 'session', user: { id: 7 }, ...overrides }) as unknown as Request;
const res = () => ({ cookie: vi.fn() }) as unknown as Response & { cookie: ReturnType<typeof vi.fn> };

const ROUTES = ['didChallenge', 'didVerify', 'didLinks', 'didLink', 'didUnlink'] as const;

describe('AuthController — sign in with a DID', () => {
  let controller: AuthController;
  let authService: MockProxy<AuthService>;
  let sessionManager: MockProxy<SessionManager>;
  let userRepository: MockProxy<UserRepository>;
  let didAuth: {
    enabled: boolean;
    issueChallenge: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
    findUserId: ReturnType<typeof vi.fn>;
    link: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };

  async function build(provideDidAuth = true) {
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
        ...(provideDidAuth ? [{ provide: DidAuthService, useValue: didAuth }] : []),
      ],
    }).compile();

    moduleRef.get(ConfigurationService).get.mockReturnValue({ experimental: { insecureCookie: false } } as never);
    moduleRef.get(ConfigurationService).getConfig.mockReturnValue({} as never);

    return moduleRef;
  }

  beforeEach(async () => {
    didAuth = {
      enabled: true,
      issueChallenge: vi.fn(),
      verify: vi.fn().mockResolvedValue({ did: DID }),
      findUserId: vi.fn().mockResolvedValue(7),
      link: vi.fn().mockResolvedValue('linked'),
      unlink: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };
    const moduleRef = await build();
    controller = moduleRef.get(AuthController);
    authService = moduleRef.get(AuthService);
    sessionManager = moduleRef.get(SessionManager);
    userRepository = moduleRef.get(UserRepository);
    authService.getCookieDomain.mockReturnValue(undefined as never);
    sessionManager.createSession.mockResolvedValue('sid-new' as never);
    userRepository.getUserDtoById.mockResolvedValue(ACTIVE as never);
  });

  afterEach(() => {
    delete process.env[DID_AUTH_FLAG];
  });

  describe('while the flag is off', () => {
    const call = (route: (typeof ROUTES)[number]) => {
      const r = req();
      switch (route) {
        case 'didChallenge':
          return controller.didChallenge(r);
        case 'didVerify':
          return controller.didVerify(PROOF as never, res(), r);
        case 'didLinks':
          return controller.didLinks(r);
        case 'didLink':
          return controller.didLink(PROOF as never, r);
        case 'didUnlink':
          return controller.didUnlink({ did: DID } as never, r);
      }
    };

    it.each(ROUTES)('%s answers 404 and touches nothing', async (route) => {
      didAuth.enabled = false;

      await expect(call(route)).rejects.toBeInstanceOf(NotFoundException);

      expect(didAuth.issueChallenge).not.toHaveBeenCalled();
      expect(didAuth.verify).not.toHaveBeenCalled();
      expect(didAuth.link).not.toHaveBeenCalled();
      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });

    it.each(ROUTES)('%s answers 404 when the service is not even provided', async (route) => {
      const bare = (await build(false)).get(AuthController);
      const r = req();
      const attempt = {
        didChallenge: () => bare.didChallenge(r),
        didVerify: () => bare.didVerify(PROOF as never, res(), r),
        didLinks: () => bare.didLinks(r),
        didLink: () => bare.didLink(PROOF as never, r),
        didUnlink: () => bare.didUnlink({ did: DID } as never, r),
      }[route];

      await expect(attempt()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is enforced before any other guard on every route: the flag guard comes first', () => {
      for (const route of ROUTES) {
        const guards = Reflect.getMetadata('__guards__', AuthController.prototype[route]) as unknown[];

        expect(guards[0], route).toBe(DidAuthFlagGuard);
      }
      for (const route of ['didLinks', 'didLink', 'didUnlink'] as const) {
        expect(Reflect.getMetadata('__guards__', AuthController.prototype[route]), route).toEqual([DidAuthFlagGuard, AuthGuard]);
      }
    });

    it('DidAuthFlagGuard answers 404 to everyone unless the environment says exactly "true"', () => {
      const guard = new DidAuthFlagGuard();

      expect(() => guard.canActivate()).toThrow(NotFoundException);
      for (const value of ['1', 'TRUE', 'yes', '', ' true']) {
        process.env[DID_AUTH_FLAG] = value;
        expect(() => guard.canActivate()).toThrow(NotFoundException);
      }
      process.env[DID_AUTH_FLAG] = 'true';
      expect(guard.canActivate()).toBe(true);
    });
  });

  describe('POST /auth/did/challenge', () => {
    const challenge = { challengeId: PROOF.challengeId, nonce: 'n'.repeat(32), audience: 'urn:ci-hub:x', expiresAt: 1_800_000_000_000 };

    it('hands out a challenge', async () => {
      didAuth.issueChallenge.mockResolvedValue(challenge);

      await expect(controller.didChallenge(req())).resolves.toEqual(challenge);
    });

    it('limits how many a client can ask for in a minute', async () => {
      didAuth.issueChallenge.mockResolvedValue(challenge);

      for (let i = 0; i < 20; i++) {
        await controller.didChallenge(req());
      }
      await expect(controller.didChallenge(req())).rejects.toMatchObject({
        message: 'AUTH_ERROR_RATE_LIMITED',
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
      expect(didAuth.issueChallenge).toHaveBeenCalledTimes(20);
    });
  });

  describe('POST /auth/did/verify', () => {
    it('signs in the person the DID is linked to: a session, the session cookie, the old ids replaced', async () => {
      const response = res();

      await expect(controller.didVerify(PROOF as never, response, req({ cookies: { [SESSION_COOKIE_NAME]: 'sid-old' } }))).resolves.toEqual({
        success: true,
        sessionId: 'sid-new',
      });

      expect(didAuth.verify).toHaveBeenCalledWith(PROOF.challengeId, PROOF.idToken);
      expect(didAuth.findUserId).toHaveBeenCalledWith(DID);
      expect(sessionManager.createSession).toHaveBeenCalledWith(7);
      expect(sessionManager.deleteSession).toHaveBeenCalledWith('sid-old');
      expect(response.cookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, 'sid-new', expect.objectContaining({ httpOnly: true, sameSite: 'lax' }));
    });

    it('asks for the second factor when the person has one: the DID replaces the password, not the TOTP', async () => {
      userRepository.getUserDtoById.mockResolvedValue({ ...ACTIVE, totpEnabled: true } as never);
      authService.beginTotpStep.mockReturnValue('totp-1');
      const response = res();

      await expect(controller.didVerify(PROOF as never, response, req())).resolves.toEqual({ success: true, totpSessionId: 'totp-1' });

      expect(authService.beginTotpStep).toHaveBeenCalledWith(7);
      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(response.cookie).not.toHaveBeenCalled();
    });

    it('does not sign in, create a person or link anything for a DID nobody linked: 403 DID_NOT_LINKED', async () => {
      didAuth.findUserId.mockResolvedValue(null);
      const response = res();

      const error = await controller.didVerify(PROOF as never, response, req()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'DID_NOT_LINKED' });
      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(didAuth.link).not.toHaveBeenCalled();
      expect(response.cookie).not.toHaveBeenCalled();
    });

    it.each([
      ['revoked', { ...ACTIVE, accessStatus: 'revoked' }],
      ['gone', undefined],
    ])('refuses a linked person who is %s with the same 401 as a proof that did not verify', async (_name, user) => {
      userRepository.getUserDtoById.mockResolvedValue(user as never);
      const response = res();

      const revoked = await controller.didVerify(PROOF as never, response, req()).catch((e: unknown) => e);
      didAuth.verify.mockRejectedValueOnce(new DidAuthRefusal('bad-signature'));
      const unverified = await controller.didVerify(PROOF as never, res(), req()).catch((e: unknown) => e);

      expect(revoked).toBeInstanceOf(UnauthorizedException);
      expect((revoked as UnauthorizedException).getResponse()).toEqual((unverified as UnauthorizedException).getResponse());
      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(response.cookie).not.toHaveBeenCalled();
    });

    it('answers every refusal with one and the same 401, whichever check failed', async () => {
      const reasons: DidAuthRefusalReason[] = [
        'unknown-challenge',
        'malformed',
        'bad-alg',
        'bad-did',
        'bad-kid',
        'bad-signature',
        'bad-claims',
        'bad-nonce',
      ];
      const bodies = new Set<string>();

      for (const reason of reasons) {
        didAuth.verify.mockRejectedValueOnce(new DidAuthRefusal(reason));
        const error = await controller
          .didVerify(PROOF as never, res(), req({ ip: `203.0.113.${reasons.indexOf(reason) + 20}` }))
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(UnauthorizedException);
        bodies.add(JSON.stringify((error as UnauthorizedException).getResponse()));
      }

      expect(bodies.size).toBe(1);
      expect([...bodies][0]).not.toMatch(/nonce|signature|alg|audience|expired|challenge/i);
      expect(didAuth.findUserId).not.toHaveBeenCalled();
      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });

    it('does not turn an unexpected failure into a 401', async () => {
      didAuth.verify.mockRejectedValueOnce(new Error('cache offline'));

      await expect(controller.didVerify(PROOF as never, res(), req())).rejects.toThrow('cache offline');
    });

    it('stops answering a client that keeps presenting bad proofs, without asking the service again', async () => {
      didAuth.verify.mockRejectedValue(new DidAuthRefusal('bad-signature'));

      for (let i = 0; i < 10; i++) {
        await expect(controller.didVerify(PROOF as never, res(), req())).rejects.toBeInstanceOf(UnauthorizedException);
      }
      await expect(controller.didVerify(PROOF as never, res(), req())).rejects.toMatchObject({
        message: 'AUTH_ERROR_RATE_LIMITED',
        status: HttpStatus.TOO_MANY_REQUESTS,
      });

      expect(didAuth.verify).toHaveBeenCalledTimes(10);
    });

    it('counts "verified but not linked" against the client too, and never limits people who sign in', async () => {
      for (let i = 0; i < 40; i++) {
        await controller.didVerify(PROOF as never, res(), req());
      }
      expect(didAuth.verify).toHaveBeenCalledTimes(40);

      didAuth.findUserId.mockResolvedValue(null);
      for (let i = 0; i < 10; i++) {
        await expect(controller.didVerify(PROOF as never, res(), req({ ip: '198.51.100.5' }))).rejects.toBeInstanceOf(ForbiddenException);
      }
      await expect(controller.didVerify(PROOF as never, res(), req({ ip: '198.51.100.5' }))).rejects.toMatchObject({
        message: 'AUTH_ERROR_RATE_LIMITED',
      });
    });
  });

  describe('GET /auth/did/links', () => {
    it('lists the signed-in person’s own links', async () => {
      didAuth.list.mockResolvedValue([{ did: DID, linkedAt: '2026-11-05 12:00:00' }]);

      await expect(controller.didLinks(req())).resolves.toEqual({ links: [{ did: DID, linkedAt: '2026-11-05 12:00:00' }] });
      expect(didAuth.list).toHaveBeenCalledWith(7);
    });
  });

  describe('POST /auth/did/link and DELETE /auth/did/link', () => {
    it('links the DID to the signed-in session’s person, taken from the session and never from the body', async () => {
      const body = { ...PROOF, userId: 999, user: { id: 999 } };

      await expect(controller.didLink(body as never, req({ user: { id: 7 } }))).resolves.toEqual({ success: true, did: DID });

      expect(didAuth.link).toHaveBeenCalledWith(7, DID);
    });

    it('does not link on a proof that does not verify', async () => {
      didAuth.verify.mockRejectedValueOnce(new DidAuthRefusal('bad-signature'));

      await expect(controller.didLink(PROOF as never, req())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(didAuth.link).not.toHaveBeenCalled();
    });

    it('passes a 409 for a DID that is bound to someone else straight through', async () => {
      didAuth.link.mockRejectedValueOnce(new ConflictException({ code: 'DID_ALREADY_LINKED' }));

      await expect(controller.didLink(PROOF as never, req())).rejects.toBeInstanceOf(ConflictException);
    });

    it('unlinks only the signed-in person’s own binding', async () => {
      await expect(controller.didUnlink({ did: DID } as never, req({ user: { id: 7 } }))).resolves.toEqual({ success: true, did: DID });

      expect(didAuth.unlink).toHaveBeenCalledWith(7, DID);
    });

    it('answers 404 for a DID the person has not linked, whoever else holds it', async () => {
      didAuth.unlink.mockRejectedValueOnce(new NotFoundException({ code: 'DID_NOT_LINKED' }));

      await expect(controller.didUnlink({ did: DID } as never, req())).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('is for an interactive Hub session, never a machine credential or another site', () => {
      // The Portal push key, the host-local key and the CLI token all speak as the first operator.
      const attempts = {
        list: (r: Request) => controller.didLinks(r),
        link: (r: Request) => controller.didLink(PROOF as never, r),
        unlink: (r: Request) => controller.didUnlink({ did: DID } as never, r),
      };

      it.each(['portal-device', 'cli', 'host-local', 'qa-read', undefined])(
        'refuses the %s principal on every route, before spending the challenge',
        async (principal) => {
          for (const [name, attempt] of Object.entries(attempts)) {
            const error = await attempt(req({ hubPrincipal: principal })).catch((e: unknown) => e);

            expect(error, name).toBeInstanceOf(ForbiddenException);
            expect((error as ForbiddenException).getResponse(), name).toMatchObject({ code: 'DID_LINK_REQUIRES_SESSION' });
          }
          expect(didAuth.verify).not.toHaveBeenCalled();
          expect(didAuth.link).not.toHaveBeenCalled();
          expect(didAuth.unlink).not.toHaveBeenCalled();
        },
      );

      it('refuses a request with no user', async () => {
        await expect(controller.didLink(PROOF as never, req({ user: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
      });

      it.each(['cross-site', 'same-site'])('refuses a change a browser says another site sent (%s)', async (site) => {
        const headers = { 'sec-fetch-site': site };

        await expect(controller.didLink(PROOF as never, req({ headers }))).rejects.toBeInstanceOf(ForbiddenException);
        await expect(controller.didUnlink({ did: DID } as never, req({ headers }))).rejects.toBeInstanceOf(ForbiddenException);
        expect(didAuth.verify).not.toHaveBeenCalled();
        expect(didAuth.link).not.toHaveBeenCalled();
        expect(didAuth.unlink).not.toHaveBeenCalled();
      });

      it('accepts the Hub’s own pages (same-origin) and a client that sends no fetch metadata', async () => {
        await controller.didLink(PROOF as never, req({ headers: { 'sec-fetch-site': 'same-origin' } }));
        await controller.didUnlink({ did: DID } as never, req());

        expect(didAuth.link).toHaveBeenCalledTimes(1);
        expect(didAuth.unlink).toHaveBeenCalledTimes(1);
      });

      it('lets a listing through from any browser origin: it changes nothing', async () => {
        await expect(controller.didLinks(req({ headers: { 'sec-fetch-site': 'cross-site' } }))).resolves.toEqual({ links: [] });
      });
    });
  });
});
