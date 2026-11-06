/**
 * Sign in with a DID, at the controller: the link-first rule, the one answer to every refusal, the
 * membership check, the codes a client reads. Each handler is called directly here, so the guards in
 * front of it do not run; their metadata is pinned below and their behaviour is `did-auth.guard.test.ts`.
 * The proof itself (alg, audience, nonce, signature) is `did-auth.service.test.ts`, and the whole stack
 * with real guards, middleware and filter is `did-auth.http.test.ts`.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { DemoModeGuard } from '@/common/guards/demo-mode.guard';
import { TranslatableError } from '@/common/error/translatable-error';
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
import { DidAuthFlagGuard, DidAuthJsonGuard, DidAuthSameOriginGuard } from '../did-auth.guard';
import { DID_AUTH_FLAG, DidAuthRefusal, type DidAuthRefusalReason, DidAuthService } from '../did-auth.service';
import { ForwardAuthIdentityResolver } from '../forward-auth-identity.resolver';
import { ForwardAuthSecretResolver } from '../forward-auth-secret.resolver';
import { HubSessionGuard } from '../hub-session.guard';
import { MemoryApiKeyCheck } from '../memory-api-key.check';
import { SessionManager } from '../session.manager';

const DID = 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw';
const PROOF = { challengeId: '11111111-2222-4333-8444-555555555555', idToken: 'a.b.c' };
const ACTIVE = { id: 7, username: 'op@example.com', totpEnabled: false, accessStatus: 'active' };

/** The route behind each handler, as a client sees it (the global prefix is `/api`). */
const ROUTES = {
  didChallenge: { method: 'POST', path: '/api/auth/did/challenge' },
  didVerify: { method: 'POST', path: '/api/auth/did/verify' },
  didLinks: { method: 'GET', path: '/api/auth/did/links' },
  didLink: { method: 'POST', path: '/api/auth/did/link' },
  didUnlink: { method: 'DELETE', path: '/api/auth/did/link' },
} as const;
type RouteName = keyof typeof ROUTES;
const ROUTE_NAMES = Object.keys(ROUTES) as RouteName[];

interface RequestOverrides {
  ip?: string;
  hubPrincipal?: string;
  user?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  method?: string;
  originalUrl?: string;
  url?: string;
}

const req = (overrides: RequestOverrides = {}) =>
  ({
    ip: '203.0.113.9',
    headers: {},
    cookies: {},
    hubPrincipal: 'session',
    user: { id: 7 },
    method: 'POST',
    originalUrl: '/api/auth/did/link',
    url: '/api/auth/did/link',
    ...overrides,
  }) as unknown as Request;
const res = () => ({ cookie: vi.fn() }) as unknown as Response & { cookie: ReturnType<typeof vi.fn> };

/** What a client reads from a thrown error: the status and the i18n key the exception filter turns into `message`. */
async function answerOf(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  const error = await promise.then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TranslatableError);
  const refusal = error as TranslatableError;

  return { status: refusal.getStatus(), message: (refusal.getResponse() as { message: string }).message };
}

describe('AuthController — sign in with a DID', () => {
  let controller: AuthController;
  let authService: MockProxy<AuthService>;
  let sessionManager: MockProxy<SessionManager>;
  let userRepository: MockProxy<UserRepository>;
  let logger: MockProxy<LoggerService>;
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

    const config = moduleRef.get(ConfigurationService) as unknown as MockProxy<ConfigurationService>;
    config.get.mockReturnValue({ experimental: { insecureCookie: false } } as never);
    config.getConfig.mockReturnValue({} as never);

    return moduleRef;
  }

  beforeEach(async () => {
    // The ambient environment is not this test's business.
    delete process.env[DID_AUTH_FLAG];
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
    logger = moduleRef.get(LoggerService);
    authService.getCookieDomain.mockReturnValue(undefined as never);
    authService.assertStillOrgMember.mockResolvedValue(undefined as never);
    sessionManager.createSession.mockResolvedValue('sid-new' as never);
    userRepository.getUserDtoById.mockResolvedValue(ACTIVE as never);
  });

  afterEach(() => {
    delete process.env[DID_AUTH_FLAG];
  });

  /** Nothing the DID routes do may make a person, a registration or a binding the signed-in owner did not make. */
  const expectNothingCreated = () => {
    expect(userRepository.createUser).not.toHaveBeenCalled();
    expect(userRepository.createFirstOperator).not.toHaveBeenCalled();
    expect(authService.register).not.toHaveBeenCalled();
    expect(didAuth.link).not.toHaveBeenCalled();
  };

  describe('while the flag is off', () => {
    const invoke = (c: AuthController, route: RouteName, r: Request) => {
      switch (route) {
        case 'didChallenge':
          return c.didChallenge({}, r);
        case 'didVerify':
          return c.didVerify(PROOF as never, res(), r);
        case 'didLinks':
          return c.didLinks(r);
        case 'didLink':
          return c.didLink(PROOF as never, r);
        case 'didUnlink':
          return c.didUnlink({ did: DID } as never, r);
      }
    };
    const requestFor = (route: RouteName) => req({ method: ROUTES[route].method, originalUrl: ROUTES[route].path, url: ROUTES[route].path });

    const expectOnlyTheNotFoundOfAnUnknownRoute = async (c: AuthController, route: RouteName) => {
      const request = requestFor(route);

      const error = await invoke(c, route, request).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toEqual({
        message: `Cannot ${ROUTES[route].method} ${ROUTES[route].path}`,
        error: 'Not Found',
        statusCode: 404,
      });
      // Nest's own not-found handler reports the path below the global prefix.
      expect(request.url).toBe(ROUTES[route].path.slice('/api'.length));
    };

    it.each(ROUTE_NAMES)('%s answers the 404 of a route that does not exist, and touches nothing', async (route) => {
      didAuth.enabled = false;

      await expectOnlyTheNotFoundOfAnUnknownRoute(controller, route);

      expect(didAuth.issueChallenge).not.toHaveBeenCalled();
      expect(didAuth.verify).not.toHaveBeenCalled();
      expect(didAuth.findUserId).not.toHaveBeenCalled();
      expect(didAuth.list).not.toHaveBeenCalled();
      expect(didAuth.unlink).not.toHaveBeenCalled();
      expectNothingCreated();
      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });

    it.each(ROUTE_NAMES)('%s answers the same 404 when the service is not provided at all', async (route) => {
      const bare = (await build(false)).get(AuthController);

      await expectOnlyTheNotFoundOfAnUnknownRoute(bare, route);
    });
  });

  describe('guards', () => {
    const guardsOf = (route: RouteName) => Reflect.getMetadata('__guards__', AuthController.prototype[route]) as unknown[];

    it('puts the flag guard first on every route, so the feature is absent before anything else is asked', () => {
      for (const route of ROUTE_NAMES) {
        expect(guardsOf(route)[0], route).toBe(DidAuthFlagGuard);
      }
    });

    it('lists exactly the guards each route needs, in order', () => {
      expect(guardsOf('didChallenge')).toEqual([DidAuthFlagGuard]);
      expect(guardsOf('didVerify')).toEqual([DidAuthFlagGuard, DidAuthJsonGuard]);
      expect(guardsOf('didLinks')).toEqual([DidAuthFlagGuard, AuthGuard, HubSessionGuard]);
      // A change made with the person's cookie: a person's own session, not the shared demo user, not another site, not a form post.
      expect(guardsOf('didLink')).toEqual([DidAuthFlagGuard, AuthGuard, HubSessionGuard, DemoModeGuard, DidAuthSameOriginGuard, DidAuthJsonGuard]);
      expect(guardsOf('didUnlink')).toEqual([DidAuthFlagGuard, AuthGuard, HubSessionGuard, DemoModeGuard, DidAuthSameOriginGuard, DidAuthJsonGuard]);
    });
  });

  describe('POST /auth/did/challenge', () => {
    const challenge = {
      challengeId: PROOF.challengeId,
      nonce: 'n'.repeat(32),
      audience: 'urn:ci-hub:x',
      purpose: 'sign-in',
      expiresAt: 1_800_000_000_000,
    };

    it('hands out a challenge', async () => {
      didAuth.issueChallenge.mockResolvedValue(challenge);

      await expect(controller.didChallenge({}, req())).resolves.toEqual(challenge);
    });

    it.each([
      ['no body at all', undefined],
      ['a null body', null],
      ['an empty object', {}],
      ['an explicit sign-in', { purpose: 'sign-in' }],
      ['an unrelated field', { userId: 999 }],
    ])('issues a challenge for signing in given %s', async (_name, body) => {
      didAuth.issueChallenge.mockResolvedValue(challenge);

      await controller.didChallenge(body, req());

      expect(didAuth.issueChallenge).toHaveBeenCalledExactlyOnceWith('sign-in');
    });

    it('issues a challenge for linking when the body asks for one', async () => {
      didAuth.issueChallenge.mockResolvedValue({ ...challenge, purpose: 'link' });

      await expect(controller.didChallenge({ purpose: 'link' }, req())).resolves.toMatchObject({ purpose: 'link' });
      expect(didAuth.issueChallenge).toHaveBeenCalledExactlyOnceWith('link');
    });

    it.each([['unlink'], ['SIGN-IN'], [''], [5], [null], [['link']], [{}]])(
      'refuses the purpose %j with a 400 and issues nothing',
      async (purpose) => {
        await expect(controller.didChallenge({ purpose }, req())).rejects.toBeInstanceOf(BadRequestException);

        expect(didAuth.issueChallenge).not.toHaveBeenCalled();
      },
    );

    it.each([[[]], ['link'], [42], [true]])('refuses a body that is not an object (%j)', async (body) => {
      await expect(controller.didChallenge(body, req())).rejects.toBeInstanceOf(BadRequestException);

      expect(didAuth.issueChallenge).not.toHaveBeenCalled();
    });

    it('limits a client to 20 challenges a minute', async () => {
      didAuth.issueChallenge.mockResolvedValue(challenge);

      for (let i = 0; i < 20; i++) {
        await controller.didChallenge({}, req());
      }
      await expect(answerOf(controller.didChallenge({}, req()))).resolves.toEqual({ status: 429, message: 'AUTH_ERROR_RATE_LIMITED' });

      expect(didAuth.issueChallenge).toHaveBeenCalledTimes(20);
    });

    it('counts clients separately', async () => {
      didAuth.issueChallenge.mockResolvedValue(challenge);
      for (let i = 0; i < 20; i++) {
        await controller.didChallenge({}, req({ ip: '198.51.100.1' }));
      }

      await expect(controller.didChallenge({}, req({ ip: '198.51.100.2' }))).resolves.toEqual(challenge);
    });

    it('passes through the 503 of a Hub whose issuer cannot be read', async () => {
      didAuth.issueChallenge.mockRejectedValueOnce(new TranslatableError('AUTH_ERROR_DID_UNAVAILABLE', undefined, 503));

      await expect(answerOf(controller.didChallenge({}, req()))).resolves.toEqual({ status: 503, message: 'AUTH_ERROR_DID_UNAVAILABLE' });
    });
  });

  describe('POST /auth/did/verify', () => {
    it('signs in the person the DID is linked to: a session, the session cookie, the old id replaced', async () => {
      const response = res();

      await expect(controller.didVerify(PROOF as never, response, req({ cookies: { [SESSION_COOKIE_NAME]: 'sid-old' } }))).resolves.toEqual({
        success: true,
        sessionId: 'sid-new',
      });

      expect(didAuth.verify).toHaveBeenCalledExactlyOnceWith(PROOF.challengeId, PROOF.idToken, 'sign-in');
      expect(didAuth.findUserId).toHaveBeenCalledExactlyOnceWith(DID);
      expect(userRepository.getUserDtoById).toHaveBeenCalledExactlyOnceWith(7);
      expect(sessionManager.createSession).toHaveBeenCalledExactlyOnceWith(7);
      expect(sessionManager.deleteSession).toHaveBeenCalledExactlyOnceWith('sid-old');
      expect(response.cookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, 'sid-new', expect.objectContaining({ httpOnly: true, sameSite: 'lax' }));
      expectNothingCreated();
    });

    it('signs in whichever person the link names, not a fixed one', async () => {
      didAuth.findUserId.mockResolvedValue(31);
      userRepository.getUserDtoById.mockResolvedValue({ ...ACTIVE, id: 31 } as never);

      await controller.didVerify(PROOF as never, res(), req());

      expect(userRepository.getUserDtoById).toHaveBeenCalledExactlyOnceWith(31);
      expect(authService.assertStillOrgMember).toHaveBeenCalledExactlyOnceWith(31);
      expect(sessionManager.createSession).toHaveBeenCalledExactlyOnceWith(31);
    });

    describe('asks Portal about membership as every other first factor does', () => {
      it('checks the person is still a member of the organization BEFORE a session exists', async () => {
        await controller.didVerify(PROOF as never, res(), req());

        expect(authService.assertStillOrgMember).toHaveBeenCalledExactlyOnceWith(7);
        expect(authService.assertStillOrgMember.mock.invocationCallOrder[0]).toBeLessThan(
          sessionManager.createSession.mock.invocationCallOrder[0] as number,
        );
      });

      it('refuses with the membership answer when Portal says the person was removed, and creates no session', async () => {
        authService.assertStillOrgMember.mockRejectedValueOnce(new TranslatableError('AUTH_ERROR_NOT_ORG_MEMBER', undefined, 403));
        const response = res();

        await expect(answerOf(controller.didVerify(PROOF as never, response, req()))).resolves.toEqual({
          status: 403,
          message: 'AUTH_ERROR_NOT_ORG_MEMBER',
        });

        expect(sessionManager.createSession).not.toHaveBeenCalled();
        expect(response.cookie).not.toHaveBeenCalled();
      });

      it('does not hand a person who was removed a second-factor step either', async () => {
        userRepository.getUserDtoById.mockResolvedValue({ ...ACTIVE, totpEnabled: true } as never);
        authService.assertStillOrgMember.mockRejectedValueOnce(new TranslatableError('AUTH_ERROR_NOT_ORG_MEMBER', undefined, 403));

        await expect(controller.didVerify(PROOF as never, res(), req())).rejects.toBeInstanceOf(TranslatableError);

        expect(authService.beginTotpStep).not.toHaveBeenCalled();
      });

      it('lets the person in when the check itself lets them in, as it does when Portal cannot be reached', async () => {
        // assertStillOrgMember resolves for "unknown": its own tests pin which Portal answers those are.
        await expect(controller.didVerify(PROOF as never, res(), req())).resolves.toEqual({ success: true, sessionId: 'sid-new' });
      });

      it('does not ask Portal about a person who is revoked, or about a DID nobody linked', async () => {
        userRepository.getUserDtoById.mockResolvedValue({ ...ACTIVE, accessStatus: 'revoked' } as never);
        await controller.didVerify(PROOF as never, res(), req()).catch(() => undefined);

        didAuth.findUserId.mockResolvedValue(null);
        await controller.didVerify(PROOF as never, res(), req({ ip: '198.51.100.7' })).catch(() => undefined);

        expect(authService.assertStillOrgMember).not.toHaveBeenCalled();
      });
    });

    it('asks for the second factor when the person has one: the DID replaces the password, not the TOTP', async () => {
      userRepository.getUserDtoById.mockResolvedValue({ ...ACTIVE, totpEnabled: true } as never);
      authService.beginTotpStep.mockReturnValue('totp-1');
      const response = res();

      await expect(controller.didVerify(PROOF as never, response, req())).resolves.toEqual({ success: true, totpSessionId: 'totp-1' });

      expect(authService.beginTotpStep).toHaveBeenCalledExactlyOnceWith(7);
      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(response.cookie).not.toHaveBeenCalled();
    });

    it('does not sign in, create a person or link anything for a DID nobody linked: 403 and a code to read', async () => {
      didAuth.findUserId.mockResolvedValue(null);
      const response = res();

      await expect(answerOf(controller.didVerify(PROOF as never, response, req()))).resolves.toEqual({
        status: 403,
        message: 'AUTH_ERROR_DID_NOT_LINKED',
      });

      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(userRepository.getUserDtoById).not.toHaveBeenCalled();
      expect(response.cookie).not.toHaveBeenCalled();
      expectNothingCreated();
    });

    it.each([
      ['revoked', { ...ACTIVE, accessStatus: 'revoked' }],
      ['gone', undefined],
    ])('refuses a linked person who is %s with the same 401 as a proof that did not verify', async (_name, user) => {
      userRepository.getUserDtoById.mockResolvedValue(user as never);
      const response = res();

      const revoked = await answerOf(controller.didVerify(PROOF as never, response, req()));
      didAuth.verify.mockRejectedValueOnce(new DidAuthRefusal('bad-signature'));
      const unverified = await answerOf(controller.didVerify(PROOF as never, res(), req()));

      expect(revoked).toEqual({ status: 401, message: 'AUTH_ERROR_DID_SIGN_IN_REFUSED' });
      expect(unverified).toEqual(revoked);
      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(response.cookie).not.toHaveBeenCalled();
    });

    it('answers every refusal with one and the same 401, whichever check failed', async () => {
      const reasons: DidAuthRefusalReason[] = [
        'unknown-challenge',
        'wrong-purpose',
        'malformed',
        'bad-alg',
        'bad-did',
        'bad-kid',
        'bad-signature',
        'bad-claims',
        'bad-nonce',
      ];
      const answers = new Set<string>();

      for (const [index, reason] of reasons.entries()) {
        didAuth.verify.mockRejectedValueOnce(new DidAuthRefusal(reason));

        const answer = await answerOf(controller.didVerify(PROOF as never, res(), req({ ip: `203.0.113.${index + 20}` })));

        answers.add(JSON.stringify(answer));
        // The reason is for the operator's debug log, not for the caller.
        expect(logger.debug).toHaveBeenCalledWith('DID proof refused', { purpose: 'sign-in', reason });
      }

      expect([...answers]).toEqual([JSON.stringify({ status: 401, message: 'AUTH_ERROR_DID_SIGN_IN_REFUSED' })]);
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
        await expect(answerOf(controller.didVerify(PROOF as never, res(), req()))).resolves.toMatchObject({ status: 401 });
      }
      await expect(answerOf(controller.didVerify(PROOF as never, res(), req()))).resolves.toEqual({
        status: 429,
        message: 'AUTH_ERROR_RATE_LIMITED',
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
        await expect(answerOf(controller.didVerify(PROOF as never, res(), req({ ip: '198.51.100.5' })))).resolves.toMatchObject({ status: 403 });
      }
      await expect(answerOf(controller.didVerify(PROOF as never, res(), req({ ip: '198.51.100.5' })))).resolves.toEqual({
        status: 429,
        message: 'AUTH_ERROR_RATE_LIMITED',
      });
    });
  });

  describe('GET /auth/did/links', () => {
    it('lists the signed-in person’s own links', async () => {
      didAuth.list.mockResolvedValue([{ did: DID, linkedAt: '2026-11-05 12:00:00' }]);

      await expect(controller.didLinks(req())).resolves.toEqual({ links: [{ did: DID, linkedAt: '2026-11-05 12:00:00' }] });
      expect(didAuth.list).toHaveBeenCalledExactlyOnceWith(7);
    });
  });

  describe('POST /auth/did/link', () => {
    it('links the DID to the signed-in session’s person, taken from the session and never from the body', async () => {
      const body = { ...PROOF, userId: 999, user: { id: 999 } };

      await expect(controller.didLink(body as never, req({ user: { id: 7 } }))).resolves.toEqual({ success: true, did: DID });

      expect(didAuth.link).toHaveBeenCalledExactlyOnceWith(7, DID);
    });

    it('verifies the proof as a LINK, not as a sign-in', async () => {
      await controller.didLink(PROOF as never, req());

      expect(didAuth.verify).toHaveBeenCalledExactlyOnceWith(PROOF.challengeId, PROOF.idToken, 'link');
    });

    it('answers a proof that does not verify with a 400 and a code, never a 401, and links nothing', async () => {
      // The SPA reads any 401 as "your session ended" and signs the person out of the page they are on.
      didAuth.verify.mockRejectedValueOnce(new DidAuthRefusal('bad-signature'));

      await expect(answerOf(controller.didLink(PROOF as never, req()))).resolves.toEqual({ status: 400, message: 'AUTH_ERROR_DID_PROOF_REFUSED' });

      expect(didAuth.link).not.toHaveBeenCalled();
    });

    it('gives one answer for every reason a proof was refused, and keeps the reason to the debug log', async () => {
      const reasons: DidAuthRefusalReason[] = ['unknown-challenge', 'wrong-purpose', 'malformed', 'bad-signature', 'bad-nonce'];
      const answers = new Set<string>();

      for (const [index, reason] of reasons.entries()) {
        didAuth.verify.mockRejectedValueOnce(new DidAuthRefusal(reason));

        answers.add(JSON.stringify(await answerOf(controller.didLink(PROOF as never, req({ ip: `203.0.113.${index + 40}` })))));
        expect(logger.debug).toHaveBeenCalledWith('DID proof refused', { purpose: 'link', reason });
      }

      expect(answers.size).toBe(1);
    });

    it('does not turn an unexpected failure into a refusal', async () => {
      didAuth.verify.mockRejectedValueOnce(new Error('cache offline'));

      await expect(controller.didLink(PROOF as never, req())).rejects.toThrow('cache offline');
      expect(didAuth.link).not.toHaveBeenCalled();
    });

    it('stops reading proofs from a client that keeps presenting bad ones: ten, then 429', async () => {
      didAuth.verify.mockRejectedValue(new DidAuthRefusal('bad-signature'));

      for (let i = 0; i < 10; i++) {
        await expect(answerOf(controller.didLink(PROOF as never, req()))).resolves.toMatchObject({ status: 400 });
      }
      await expect(answerOf(controller.didLink(PROOF as never, req()))).resolves.toEqual({ status: 429, message: 'AUTH_ERROR_RATE_LIMITED' });

      expect(didAuth.verify).toHaveBeenCalledTimes(10);
    });

    it('does not count links that succeed', async () => {
      for (let i = 0; i < 30; i++) {
        await controller.didLink(PROOF as never, req());
      }

      expect(didAuth.link).toHaveBeenCalledTimes(30);
    });

    it('passes a 409 for a DID that is bound to someone else straight through, with its code', async () => {
      didAuth.link.mockRejectedValueOnce(new TranslatableError('AUTH_ERROR_DID_ALREADY_LINKED', undefined, 409));

      await expect(answerOf(controller.didLink(PROOF as never, req()))).resolves.toEqual({ status: 409, message: 'AUTH_ERROR_DID_ALREADY_LINKED' });
    });
  });

  describe('DELETE /auth/did/link', () => {
    it('unlinks only the signed-in person’s own binding', async () => {
      await expect(controller.didUnlink({ did: DID } as never, req({ user: { id: 7 } }))).resolves.toEqual({ success: true, did: DID });

      expect(didAuth.unlink).toHaveBeenCalledExactlyOnceWith(7, DID);
    });

    it('takes the person from the session, whatever the body says', async () => {
      await controller.didUnlink({ did: DID, userId: 999 } as never, req({ user: { id: 7 } }));

      expect(didAuth.unlink).toHaveBeenCalledExactlyOnceWith(7, DID);
    });

    it('answers 404, with a code, for a DID the person has not linked, whoever else holds it', async () => {
      didAuth.unlink.mockRejectedValueOnce(new TranslatableError('AUTH_ERROR_DID_LINK_NOT_FOUND', undefined, 404));

      await expect(answerOf(controller.didUnlink({ did: DID } as never, req()))).resolves.toEqual({
        status: 404,
        message: 'AUTH_ERROR_DID_LINK_NOT_FOUND',
      });
    });
  });

  describe('is for a person’s interactive Hub session, never a machine credential', () => {
    // The Portal push key, the host-local key and the CLI token all speak as the first operator. The guards
    // refuse them first (HubSessionGuard); the handlers repeat the refusal so one called without them still does.
    const attempts = {
      list: (r: Request) => controller.didLinks(r),
      link: (r: Request) => controller.didLink(PROOF as never, r),
      unlink: (r: Request) => controller.didUnlink({ did: DID } as never, r),
    };

    it.each(['portal-device', 'cli', 'host-local', 'qa-read', undefined])(
      'refuses the %s principal on every route, before spending the challenge',
      async (principal) => {
        for (const [name, attempt] of Object.entries(attempts)) {
          await expect(answerOf(attempt(req({ hubPrincipal: principal }))), name).resolves.toEqual({
            status: 403,
            message: 'AUTH_ERROR_SIGNED_IN_PERSON_REQUIRED',
          });
        }

        expect(didAuth.list).not.toHaveBeenCalled();
        expect(didAuth.verify).not.toHaveBeenCalled();
        expect(didAuth.link).not.toHaveBeenCalled();
        expect(didAuth.unlink).not.toHaveBeenCalled();
      },
    );

    it('refuses a session principal that has no user', async () => {
      await expect(answerOf(controller.didLink(PROOF as never, req({ user: undefined })))).resolves.toMatchObject({ status: 403 });
      await expect(answerOf(controller.didLink(PROOF as never, req({ user: { id: '7' } })))).resolves.toMatchObject({ status: 403 });
      expect(didAuth.verify).not.toHaveBeenCalled();
    });
  });
});
