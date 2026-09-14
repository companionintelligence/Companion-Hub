import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { UserRepository } from '@/modules/user/user.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { TranslatableError } from '@/common/error/translatable-error';
import { AuthController } from '../auth.controller';
import { ForwardAuthSecretResolver } from '../forward-auth-secret.resolver';
import { BearerOrgMembershipCache } from '../bearer-org-membership.cache';
import { AuthService } from '../auth.service';
import { exchangePortalAuthorizationCode, fetchPortalSessionEmail } from '../portal-sso';
import { verifyPortalIdToken } from '../portal-token';
import { SessionManager } from '../session.manager';
import { signForwardAuthUser } from '../utils/forward-auth-signing';

vi.mock('../portal-sso', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../portal-sso')>();
  return {
    ...actual,
    exchangePortalAuthorizationCode: vi.fn(),
    fetchPortalSessionEmail: vi.fn(),
  };
});

vi.mock('../portal-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../portal-token')>();
  return {
    ...actual,
    verifyPortalIdToken: vi.fn(),
  };
});

describe('AuthController', () => {
  let authController: AuthController;
  let authService: MockProxy<AuthService>;
  let logger: MockProxy<LoggerService>;
  let config: MockProxy<ConfigurationService>;
  let forwardAuthSecrets: MockProxy<ForwardAuthSecretResolver>;
  let cache: MockProxy<CacheService>;
  let userRepository: MockProxy<UserRepository>;
  let sessionManager: MockProxy<SessionManager>;
  let deviceRegistration: MockProxy<DeviceRegistrationRepository>;

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
        // Real instance, not a mock: its TTL/coalescing behaviour is what the caching tests assert.
        BearerOrgMembershipCache,
        SessionUserCache,
      ],
    }).compile();

    authController = moduleRef.get(AuthController);
    authService = moduleRef.get(AuthService);
    forwardAuthSecrets = moduleRef.get(ForwardAuthSecretResolver);
    logger = moduleRef.get(LoggerService);
    config = moduleRef.get(ConfigurationService);
    cache = moduleRef.get(CacheService);
    userRepository = moduleRef.get(UserRepository);
    sessionManager = moduleRef.get(SessionManager);
    deviceRegistration = moduleRef.get(DeviceRegistrationRepository);
    cache.getByPrefix.mockReturnValue([]);
  });

  it('should be defined', () => {
    expect(authController).toBeDefined();
  });

  describe('session cookie flags', () => {
    // `login` stands in for every Hub-session cookie call site: all of them derive host and proto from
    // the REQUEST HEADERS. (The edge-SSO consume plants an app-session cookie, pinned in its own tests.)
    const loginReq = (headers: Record<string, string>) => ({ headers }) as unknown as Request;
    const cookieRes = () => ({ cookie: vi.fn() }) as unknown as Response;

    beforeEach(() => {
      config.get.mockReturnValue({ experimental: { insecureCookie: false } } as never);
      authService.login.mockResolvedValue({ sessionId: 'sid-1' } as never);
    });

    it('flags the cookie Secure over https even when the host yields no cookie Domain', async () => {
      // `getCookieDomain` returns undefined for any non-FQDN host — an IP, `localhost`, a single
      // label — which is a statement about the Domain ATTRIBUTE (omit it, make the cookie
      // host-only), not about transport. Gating `secure` on it too handed an https visitor a
      // cookie with no Secure flag, which the browser then sends in cleartext to the same host
      // over http: the session id on the wire. The documented `https://<ip>:8443` tailnet path is
      // exactly this shape.
      authService.getCookieDomain.mockReturnValue(undefined as never);
      const res = cookieRes();

      await authController.login(
        { username: 'op', password: 'pw' } as never,
        res,
        loginReq({ 'x-forwarded-proto': 'https', 'x-forwarded-host': '10.0.0.5:8443' }),
      );

      expect(res.cookie).toHaveBeenCalledWith('ci-hub-sid', 'sid-1', expect.objectContaining({ secure: true, domain: undefined }));
    });

    it('reads only the first hop of a comma-joined forwarded proto', async () => {
      // Behind a second proxy Node joins repeated headers into one string. `'https, http'` equals
      // neither value, so an https visitor silently got a non-Secure cookie.
      authService.getCookieDomain.mockReturnValue('.example.com' as never);
      const res = cookieRes();

      await authController.login(
        { username: 'op', password: 'pw' } as never,
        res,
        loginReq({ 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'hub.example.com' }),
      );

      expect(res.cookie).toHaveBeenCalledWith('ci-hub-sid', 'sid-1', expect.objectContaining({ secure: true }));
    });

    it('strips the port before deriving the cookie domain', async () => {
      // `getCookieDomain` gates on `validator.isFQDN`, which rejects `ci.lan:8443` outright, and a
      // host-only cookie is not cosmetic on the LAN: the whole LAN fast path rests on the Hub
      // sitting at the domain ROOT, where `.ci.lan` also covers `<app>.ci.lan`. Unstripped, the
      // port makes that cookie host-only, no app subdomain sees the session, and SSO silently
      // stops working over the documented `:8443` tailnet path.
      //
      // The mock MIRRORS the real implementation — `.` + the whole input host, pinned in
      // auth.service.test.ts — rather than returning a registrable domain it never produces. A
      // `.ci.lan` result requires the apex host, which is exactly why the apex is the shape the
      // LAN design depends on: from `hub.ci.lan` the real function yields `.hub.ci.lan`, which an
      // app subdomain would NOT see.
      authService.getCookieDomain.mockImplementation(((host?: string) => (host ? `.${host}` : undefined)) as never);
      const res = cookieRes();

      await authController.login(
        { username: 'op', password: 'pw' } as never,
        res,
        loginReq({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'CI.lan:8443' }),
      );

      expect(authService.getCookieDomain).toHaveBeenCalledWith('ci.lan');
      expect(res.cookie).toHaveBeenCalledWith('ci-hub-sid', 'sid-1', expect.objectContaining({ domain: '.ci.lan' }));
    });

    it('takes the first hop of a comma-joined forwarded host before deriving the cookie domain', async () => {
      authService.getCookieDomain.mockImplementation(((host?: string) => (host ? `.${host}` : undefined)) as never);
      const res = cookieRes();

      await authController.login(
        { username: 'op', password: 'pw' } as never,
        res,
        loginReq({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'hub.example.com, proxy.example' }),
      );

      expect(authService.getCookieDomain).toHaveBeenCalledWith('hub.example.com');
      expect(res.cookie).toHaveBeenCalledWith('ci-hub-sid', 'sid-1', expect.objectContaining({ domain: '.hub.example.com' }));
    });

    it('leaves the cookie unflagged over plain http', async () => {
      // Regression pin: an http appliance must not get a Secure cookie or the browser drops it.
      authService.getCookieDomain.mockReturnValue('.ci.lan' as never);
      const res = cookieRes();

      await authController.login(
        { username: 'op', password: 'pw' } as never,
        res,
        loginReq({ 'x-forwarded-proto': 'http', 'x-forwarded-host': 'hub.ci.lan' }),
      );

      expect(res.cookie).toHaveBeenCalledWith('ci-hub-sid', 'sid-1', expect.objectContaining({ secure: false }));
    });
  });

  describe('traefik', () => {
    it('accepts a valid Portal Bearer and returns 200 with signed headers (no SSO redirect)', async () => {
      config.get.mockImplementation((key: string) => {
        if (key === 'ciCloudUrl') {
          return 'https://hub.ci.computer';
        }
        return undefined as never;
      });
      vi.mocked(verifyPortalIdToken).mockResolvedValue({
        sub: 'portal-sub',
        email: 'support@example.com',
        name: 'Support',
      });
      authService.resolvePairedOrgMembership.mockResolvedValue('member');
      forwardAuthSecrets.resolveForHost.mockResolvedValue({
        secret: 'per-app-secret',
        appUrn: 'ci-memory:ci-marketplace' as never,
        source: 'app-env',
      });

      const req = {
        user: undefined,
        headers: {
          authorization: 'Bearer portal.id.token',
          'x-forwarded-host': 'ci-memory-core7-team.companionintelligence.com',
          'x-forwarded-uri': '/api/files/upload',
        },
      } as unknown as Request;
      const setHeader = vi.fn();
      const res = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
        setHeader,
        redirect: vi.fn(),
      } as unknown as Response;

      await authController.traefik(req, res);

      expect(verifyPortalIdToken).toHaveBeenCalledWith('portal.id.token', expect.objectContaining({ publicCiCloudUrl: 'https://hub.ci.computer' }));
      expect(authService.resolvePairedOrgMembership).toHaveBeenCalledWith('portal-sub');
      expect(res.redirect).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      const headers = Object.fromEntries(setHeader.mock.calls);
      expect(headers['X-CI-Hub-User']).toBe('support@example.com');
      const timestamp = Number(headers['X-CI-Hub-User-Timestamp']);
      expect(headers['X-CI-Hub-User-Signature']).toBe(signForwardAuthUser('per-app-secret', 'support@example.com', timestamp));
    });

    it("CI-Hub#1333: rejects a valid Portal Bearer whose subject is not a member of this Hub's paired org", async () => {
      // The exploit this guards against: a token that is perfectly valid to Portal (right
      // signature, issuer, audience) but was never meant to authorize THIS appliance, because
      // every Hub in the fleet shares the same audience list.
      config.get.mockImplementation((key: string) => (key === 'ciCloudUrl' ? 'https://hub.ci.computer' : (undefined as never)));
      vi.mocked(verifyPortalIdToken).mockResolvedValue({
        sub: 'attacker-sub',
        email: 'attacker@example.com',
        name: 'Attacker',
      });
      authService.resolvePairedOrgMembership.mockResolvedValue('not-member');

      const req = {
        user: undefined,
        headers: {
          authorization: 'Bearer stolen.portal.token',
          'x-forwarded-host': 'victim-app.companionintelligence.com',
          'x-forwarded-uri': '/api/files/upload',
        },
      } as unknown as Request;
      const setHeader = vi.fn();
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), setHeader, redirect: vi.fn() } as unknown as Response;

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(setHeader).not.toHaveBeenCalled();
      expect(forwardAuthSecrets.resolveForHost).not.toHaveBeenCalled();
    });

    it('CI-Hub#1333: fails closed on a blank subject rather than treating "unknown" as "authorized"', async () => {
      // A whitespace `sub` is the blank subject that can actually reach here: `verifyPortalIdToken`
      // already returns null (-> 401) for an empty one, so asserting on `sub: ''` would only be
      // testing the mock. `'   '` is truthy, passes verification, and is what `trim()` guards.
      config.get.mockImplementation((key: string) => (key === 'ciCloudUrl' ? 'https://hub.ci.computer' : (undefined as never)));
      vi.mocked(verifyPortalIdToken).mockResolvedValue({ sub: '   ', email: 'nobody@example.com', name: null });

      const req = {
        user: undefined,
        headers: { authorization: 'Bearer weird.token', 'x-forwarded-host': 'app.companionintelligence.com' },
      } as unknown as Request;
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), setHeader: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(authService.resolvePairedOrgMembership).not.toHaveBeenCalled();
    });

    it('CI-Hub#1333: refuses a Bearer with no forwarded host instead of signing with the Hub-global secret', async () => {
      // `resolveForHost(undefined)` falls back to the Hub-global signing secret, which is exactly
      // the cross-app forgery the per-app secret exists to stop (CI-Engineering#74).
      config.get.mockImplementation((key: string) => (key === 'ciCloudUrl' ? 'https://hub.ci.computer' : (undefined as never)));

      const req = { user: undefined, headers: { authorization: 'Bearer portal.id.token' } } as unknown as Request;
      const setHeader = vi.fn();
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), setHeader, redirect: vi.fn() } as unknown as Response;

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(setHeader).not.toHaveBeenCalled();
      expect(forwardAuthSecrets.resolveForHost).not.toHaveBeenCalled();
    });

    it('refuses a COOKIE-authenticated request with no forwarded host for the same reason', async () => {
      // The Bearer branch is not the only one that signs identity headers: an authenticated session
      // with no forwarded host reached `resolveForHost('')` and got the Hub-global secret too.
      const req = { user: { id: 1, username: 'operator@example.com' }, headers: {} } as unknown as Request;
      const setHeader = vi.fn();
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), setHeader, redirect: vi.fn() } as unknown as Response;

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(setHeader).not.toHaveBeenCalled();
      expect(forwardAuthSecrets.resolveForHost).not.toHaveBeenCalled();
    });

    describe('CI-Hub#1333 membership caching', () => {
      const makeBearerReq = () =>
        ({
          user: undefined,
          headers: { authorization: 'Bearer portal.id.token', 'x-forwarded-host': 'app.companionintelligence.com' },
        }) as unknown as Request;
      const makeRes = () => ({ status: vi.fn().mockReturnThis(), send: vi.fn(), setHeader: vi.fn(), redirect: vi.fn() }) as unknown as Response;

      beforeEach(() => {
        config.get.mockImplementation((key: string) => (key === 'ciCloudUrl' ? 'https://hub.ci.computer' : (undefined as never)));
        vi.mocked(verifyPortalIdToken).mockResolvedValue({ sub: 'portal-sub', email: 'support@example.com', name: 'Support' });
        forwardAuthSecrets.resolveForHost.mockResolvedValue({
          secret: 'per-app-secret',
          appUrn: 'ci-memory:ci-marketplace' as never,
          source: 'app-env',
        });
      });

      it('reuses a positive membership result instead of asking Portal on every forwarded request', async () => {
        authService.resolvePairedOrgMembership.mockResolvedValue('member');

        await authController.traefik(makeBearerReq(), makeRes());
        await authController.traefik(makeBearerReq(), makeRes());

        expect(authService.resolvePairedOrgMembership).toHaveBeenCalledTimes(1);
      });

      it('reuses a REFUSAL too, so a client retrying in a loop cannot hammer Portal', async () => {
        // The positive case above would stay green if refusals stopped being remembered, and a
        // refused machine client is exactly the one that retries hardest.
        authService.resolvePairedOrgMembership.mockResolvedValue('not-member');

        const first = makeRes();
        const second = makeRes();
        await authController.traefik(makeBearerReq(), first);
        await authController.traefik(makeBearerReq(), second);

        expect(authService.resolvePairedOrgMembership).toHaveBeenCalledTimes(1);
        expect(first.status).toHaveBeenCalledWith(403);
        expect(second.status).toHaveBeenCalledWith(403);
      });

      it('coalesces a cold-start burst into ONE Portal round trip', async () => {
        // The cache only helps after the first answer returns, so without in-flight coalescing a
        // machine client opening ten parallel requests makes ten Portal calls — the traffic the
        // cache is there to prevent.
        let release: (value: 'member') => void = () => undefined;
        authService.resolvePairedOrgMembership.mockReturnValue(
          new Promise<'member'>((resolve) => {
            release = resolve;
          }),
        );

        const inFlight = Array.from({ length: 5 }, () => authController.traefik(makeBearerReq(), makeRes()));
        release('member');
        await Promise.all(inFlight);

        expect(authService.resolvePairedOrgMembership).toHaveBeenCalledTimes(1);
      });

      it('denies on an unresolvable membership WITHOUT remembering it, so a Portal blip is not a 60s lockout', async () => {
        authService.resolvePairedOrgMembership.mockResolvedValueOnce('unknown').mockResolvedValueOnce('member');

        const deniedRes = makeRes();
        await authController.traefik(makeBearerReq(), deniedRes);
        expect(deniedRes.status).toHaveBeenCalledWith(403);

        // Portal recovers: the very next request must ask again rather than serve the refusal.
        const allowedRes = makeRes();
        await authController.traefik(makeBearerReq(), allowedRes);

        expect(authService.resolvePairedOrgMembership).toHaveBeenCalledTimes(2);
        expect(allowedRes.status).toHaveBeenCalledWith(200);
      });

      it('survives a membership lookup that rejects outright, as a 403 rather than a 500', async () => {
        authService.resolvePairedOrgMembership.mockRejectedValue(new Error('ECONNREFUSED'));

        const res = makeRes();
        await expect(authController.traefik(makeBearerReq(), res)).resolves.not.toThrow();

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.setHeader).not.toHaveBeenCalled();
      });
    });

    it('lets Memory login and API-key traffic through without a Hub session', async () => {
      const cases: Array<{ uri?: string; extra?: Record<string, string> }> = [
        { uri: '/api/authenticate/oidc/native/exchange' },
        { uri: '/api/authenticate?client=native' },
        { uri: '/api/keys' },
        { uri: '/graphql', extra: { 'x-api-key': 'mem_live_abc' } },
      ];

      for (const { uri, extra } of cases) {
        vi.mocked(verifyPortalIdToken).mockClear();
        const req = {
          user: undefined,
          headers: {
            'x-forwarded-host': 'ci-memory-core3-team.companionintelligence.com',
            ...(uri ? { 'x-forwarded-uri': uri } : {}),
            ...extra,
          },
        } as unknown as Request;
        const res = {
          status: vi.fn().mockReturnThis(),
          send: vi.fn(),
          redirect: vi.fn(),
          setHeader: vi.fn(),
        } as unknown as Response;

        await authController.traefik(req, res);

        expect(res.redirect, uri).not.toHaveBeenCalled();
        expect(res.status, uri).toHaveBeenCalledWith(200);
        expect(verifyPortalIdToken).not.toHaveBeenCalled();
      }
    });

    it('does not treat a Memory JWT on /api/keys as an invalid Portal Bearer', async () => {
      vi.mocked(verifyPortalIdToken).mockResolvedValue(null);
      const req = {
        user: undefined,
        headers: {
          authorization: 'Bearer memory.jwt.not-portal',
          'x-forwarded-host': 'ci-memory-core3-team.companionintelligence.com',
          'x-forwarded-uri': '/api/keys',
        },
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn(),
      } as unknown as Response;

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.redirect).not.toHaveBeenCalled();
      expect(verifyPortalIdToken).not.toHaveBeenCalled();
    });

    it('returns 401 (not 302) when a Portal Bearer is present but invalid', async () => {
      config.get.mockImplementation((key: string) => {
        if (key === 'ciCloudUrl') {
          return 'https://hub.ci.computer';
        }
        return undefined as never;
      });
      vi.mocked(verifyPortalIdToken).mockResolvedValue(null);

      const req = {
        user: undefined,
        headers: {
          authorization: 'Bearer bad.token',
          'x-forwarded-host': 'ci-memory-core7-team.companionintelligence.com',
        },
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn(),
      } as unknown as Response;

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.redirect).not.toHaveBeenCalled();
    });

    it('should return 200 with a signed X-CI-Hub-User header when user is authenticated', async () => {
      // Arrange: the resolver (not config) is the source of the signing secret —
      // per-app when the forwarded host maps to an installed app (#74).
      forwardAuthSecrets.resolveForHost.mockResolvedValue({
        secret: 'per-app-secret',
        appUrn: 'importer:ci-marketplace' as never,
        source: 'app-env',
      });
      const mockUser = { id: 1, username: 'testuser' };
      const req = {
        user: mockUser,
        headers: { 'x-forwarded-host': 'importer-dev-org.ci.lan' },
      } as unknown as Request;

      const setHeader = vi.fn();
      const res = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
        setHeader,
      } as unknown as Response;

      // Act
      await authController.traefik(req, res);

      // Assert: identity header + signature + timestamp are all set, and the
      // signature verifies against the RESOLVED per-app secret and canonical message.
      expect(forwardAuthSecrets.resolveForHost).toHaveBeenCalledWith('importer-dev-org.ci.lan');
      expect(setHeader).toHaveBeenCalledWith('X-CI-Hub-User', 'testuser');
      const headers = Object.fromEntries(setHeader.mock.calls);
      const timestamp = Number(headers['X-CI-Hub-User-Timestamp']);
      expect(Number.isFinite(timestamp)).toBe(true);
      expect(headers['X-CI-Hub-User-Signature']).toBe(signForwardAuthUser('per-app-secret', 'testuser', timestamp));

      // A signature computed with any other secret must NOT match — this is what
      // stops a container on ci_os_hub_network forging the identity header, and what
      // stops one app's secret validating a header destined for another app.
      expect(headers['X-CI-Hub-User-Signature']).not.toBe(signForwardAuthUser('wrong-secret', 'testuser', timestamp));

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        'User authenticated for Traefik forward auth',
        expect.objectContaining({ username: 'testuser', secretSource: 'app-env', targetApp: 'importer:ci-marketplace' }),
      );
    });

    it('falls back to the global secret for a host that maps to no app', async () => {
      // A host that IS forwarded and simply matches no app in the map. Sending no host at all
      // exercised a different branch (it is now refused outright), so this case went uncovered.
      forwardAuthSecrets.resolveForHost.mockResolvedValue({ secret: 'global-secret', source: 'global' });
      const req = {
        user: { id: 1, username: 'testuser' },
        headers: { 'x-forwarded-host': 'dashboard.ci.lan' },
      } as unknown as Request;
      const setHeader = vi.fn();
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), setHeader } as unknown as Response;

      await authController.traefik(req, res);

      const headers = Object.fromEntries(setHeader.mock.calls);
      const timestamp = Number(headers['X-CI-Hub-User-Timestamp']);
      expect(headers['X-CI-Hub-User-Signature']).toBe(signForwardAuthUser('global-secret', 'testuser', timestamp));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('routes an unauthenticated LAN visitor into edge-sso on the derived root-domain origin', async () => {
      // The host map vouches for this host, so the edge-SSO hop will accept it as a target.
      forwardAuthSecrets.resolveAppUrnForHost.mockResolvedValue('jellyfin:ci-marketplace' as never);
      const req = {
        user: undefined,
        headers: {
          'x-forwarded-uri': '/dashboard?tab=2',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'jellyfin-myorg.companionintelligence.com',
        },
      } as unknown as Request;
      const res = { status: vi.fn().mockReturnThis(), redirect: vi.fn() } as unknown as Response;

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(302);
      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      // No cf-ray → the historical LAN shape: strip the app's (single) label, Hub assumed at
      // the root of what remains.
      expect(location.origin).toBe('https://companionintelligence.com');
      expect(location.pathname).toBe('/api/auth/edge-sso');
      // The return address preserves the full forwarded URL, path and query included.
      expect(location.searchParams.get('redirect')).toBe('https://jellyfin-myorg.companionintelligence.com/dashboard?tab=2');
      expect(logger.debug).toHaveBeenCalledWith(
        'Unauthenticated Traefik forward auth request',
        expect.objectContaining({ host: 'jellyfin-myorg.companionintelligence.com' }),
      );
    });

    it('routes a tunnel visitor to the PUBLIC hub origin with the app PUBLIC hostname as return address', async () => {
      // cf-ray marks the request as coming through Cloudflare: the forwarded `.ci.lan` host
      // identifies the app but does not resolve for the visitor — both sides of the redirect
      // must switch to public names.
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ hubSubdomain: 'hub-core-2-org', slug: 'org' } as never);
      config.getConfig.mockReturnValue({ domain: 'companionintelligence.com' } as never);
      forwardAuthSecrets.resolvePublicHostForHost.mockResolvedValue('importer-core-2-org.companionintelligence.com');
      const req = {
        user: undefined,
        headers: {
          'cf-ray': '8a1b2c3d4e5f-LAX',
          'x-forwarded-uri': '/files?dir=%2Fdata',
          'x-forwarded-proto': 'http',
          'x-forwarded-host': 'importer-core-2-org.ci.lan',
        },
      } as unknown as Request;
      const res = { status: vi.fn().mockReturnThis(), redirect: vi.fn() } as unknown as Response;

      await authController.traefik(req, res);

      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location.origin).toBe('https://hub-core-2-org.companionintelligence.com');
      expect(location.pathname).toBe('/api/auth/edge-sso');
      expect(location.searchParams.get('redirect')).toBe('https://importer-core-2-org.companionintelligence.com/files?dir=%2Fdata');
      expect(forwardAuthSecrets.resolvePublicHostForHost).toHaveBeenCalledWith('importer-core-2-org.ci.lan');
    });

    it('falls back to the LAN shape for a tunnel visitor when no public hub origin is registered', async () => {
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue(null as never);
      config.getConfig.mockReturnValue({ domain: 'example.com' } as never);
      forwardAuthSecrets.resolveAppUrnForHost.mockResolvedValue('importer:ci-marketplace' as never);
      const req = {
        user: undefined,
        headers: { 'cf-ray': 'abc-LAX', 'x-forwarded-uri': '/', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'importer-org.ci.lan' },
      } as unknown as Request;
      const res = { status: vi.fn().mockReturnThis(), redirect: vi.fn() } as unknown as Response;

      await authController.traefik(req, res);

      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location.origin).toBe('http://ci.lan');
      expect(location.searchParams.get('redirect')).toBe('http://importer-org.ci.lan/');
    });

    it('does not 500 when device_registration lookup fails during tunnel forward-auth', async () => {
      // Regression: Postgres auth/connection errors used to escape resolvePublicHub as an
      // unhandled exception on GET /api/auth/traefik (Sentry CI-HUB-BACKEND-JD). Treat like
      // "no registration" so Traefik gets a redirect instead of a hard failure.
      deviceRegistration.getFirstDeviceRegistration.mockRejectedValue(
        Object.assign(new Error('Failed query: select ... from "device_registration" limit $1\nparams: 1'), {
          cause: new Error('password authentication failed for user "companion"'),
        }),
      );
      config.getConfig.mockReturnValue({ domain: 'example.com' } as never);
      forwardAuthSecrets.resolveAppUrnForHost.mockResolvedValue('nextcloud:ci-marketplace' as never);
      const req = {
        user: undefined,
        headers: {
          'cf-ray': 'a32648954da24bbb-BUF',
          'x-forwarded-uri': '/',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'nextcloud-test-echolign.ci.lan',
        },
      } as unknown as Request;
      const res = { status: vi.fn().mockReturnThis(), redirect: vi.fn() } as unknown as Response;

      await expect(authController.traefik(req, res)).resolves.toBeUndefined();

      expect(res.redirect).toHaveBeenCalled();
      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location.origin).toBe('https://ci.lan');
      expect(logger.warn).toHaveBeenCalledWith('Failed to load device registration while resolving public Hub origin', expect.any(Error));
    });

    it('sends a tunnel visitor to the Hub login when the app has no public hostname to return to', async () => {
      // Registered appliance, but the host map cannot name a public address for this host (a
      // fresh install the map has not caught up with, a router created outside the app
      // lifecycle). Falling through to the LAN shape would hand a remote browser a
      // `.<localDomain>` origin it cannot resolve — a dead end with no way back.
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ hubSubdomain: 'hub-core-2-org', slug: 'org' } as never);
      config.getConfig.mockReturnValue({ domain: 'companionintelligence.com' } as never);
      forwardAuthSecrets.resolvePublicHostForHost.mockResolvedValue(null);
      const req = {
        user: undefined,
        headers: { 'cf-ray': 'ray-LAX', 'x-forwarded-uri': '/x', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'brand-new-org.ci.lan' },
      } as unknown as Request;
      const res = { status: vi.fn().mockReturnThis(), redirect: vi.fn() } as unknown as Response;

      await authController.traefik(req, res);

      expect(res.redirect).toHaveBeenCalledWith('https://hub-core-2-org.companionintelligence.com/login');
    });

    it('keeps the historical direct login redirect for a LAN host the app map does not know', async () => {
      // The edge-SSO hop answers a target its host map cannot vouch for with a JSON 400 — a dead
      // end for a browser. A router created outside the app lifecycle, or an app installed since
      // the last map rebuild, must therefore keep going straight to /login as it always has.
      forwardAuthSecrets.resolveAppUrnForHost.mockResolvedValue(null);
      const req = {
        user: undefined,
        headers: { 'x-forwarded-uri': '/panel', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'legacy-router.ci.lan' },
      } as unknown as Request;
      const res = { status: vi.fn().mockReturnThis(), redirect: vi.fn() } as unknown as Response;

      await authController.traefik(req, res);

      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location.origin).toBe('https://ci.lan');
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('redirect_url')).toBe('https://legacy-router.ci.lan/panel');
      expect(location.searchParams.get('app')).toBe('legacy-router');
    });

    it('refuses a request with no forwarded host instead of crashing', async () => {
      // The old code called host.split(...) on undefined — a 500 the visitor saw as a server
      // error. A forward-auth subrequest with no forwarded host has nothing to route back to.
      const req = { user: undefined, headers: { 'x-forwarded-uri': '/', 'x-forwarded-proto': 'https' } } as unknown as Request;
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.redirect).not.toHaveBeenCalled();
    });

    describe('app sessions planted by edge SSO', () => {
      const APP = 'importer:ci-marketplace';
      const APP_HOST = 'importer-core-2-org.companionintelligence.com';
      // One app answers on several names; a custom domain is another name for the same app.
      const APP_CUSTOM_DOMAIN = 'files.acme.example';
      const OTHER_APP_HOST = 'comfyui-core-2-org.companionintelligence.com';

      const appSessionReq = (host: string, { uri = '/files', headers = {} }: { uri?: string; headers?: Record<string, string> } = {}) =>
        ({
          user: undefined,
          headers: { 'x-forwarded-uri': uri, 'x-forwarded-proto': 'https', 'x-forwarded-host': host, ...headers },
          cookies: { 'ci-hub-app-sid': 'app-sid-1' },
        }) as unknown as Request;
      const makeRes = () => ({ status: vi.fn().mockReturnThis(), send: vi.fn(), setHeader: vi.fn(), redirect: vi.fn() }) as unknown as Response;
      const signedHeaders = (res: Response) => Object.fromEntries((res.setHeader as ReturnType<typeof vi.fn>).mock.calls);

      const memoryCache = () => {
        const store = new Map<string, string>();
        return {
          get: (key: string) => store.get(key),
          set: (key: string, value: string) => void store.set(key, value),
          del: (key: string) => void store.delete(key),
          getExpirationAt: (key: string) => (store.has(key) ? Date.now() + 60 * 60 * 1000 : null),
          getByPrefix: (prefix: string) => [...store.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, val]) => ({ key, val })),
        };
      };

      beforeEach(() => {
        sessionManager.resolveAppSession.mockImplementation((id: string) =>
          id === 'app-sid-1' ? { userId: 7, parentSessionId: 'sid-1', appUrn: APP as never } : null,
        );
        forwardAuthSecrets.resolveAppUrnForHost.mockImplementation(async (host) => {
          if (host === APP_HOST || host === APP_CUSTOM_DOMAIN) return APP as never;
          return host === OTHER_APP_HOST ? ('comfyui:ci-marketplace' as never) : null;
        });
        forwardAuthSecrets.resolveForHost.mockResolvedValue({ secret: 'per-app-secret', appUrn: APP as never, source: 'app-env' });
        userRepository.getUserDtoById.mockResolvedValue({ id: 7, username: 'op@example.com' } as never);
      });

      it.each([
        ['its platform hostname', APP_HOST],
        ['its custom domain', APP_CUSTOM_DOMAIN],
      ])('signs as the app-session user on %s', async (_label, host) => {
        // Bound to the app rather than to a hostname: every name the app answers on resolves to its URN.
        const res = makeRes();

        await authController.traefik(appSessionReq(host), res);

        expect(sessionManager.resolveAppSession).toHaveBeenCalledWith('app-sid-1');
        expect(res.status).toHaveBeenCalledWith(200);
        const headers = signedHeaders(res);
        expect(headers['X-CI-Hub-User']).toBe('op@example.com');
        expect(headers['X-CI-Hub-User-Signature']).toBe(
          signForwardAuthUser('per-app-secret', 'op@example.com', Number(headers['X-CI-Hub-User-Timestamp'])),
        );
      });

      it("does not sign an app session on another app's host", async () => {
        // Minted for importer. comfyui is a legitimate app on the same appliance and still must not be
        // told importer's user: the request falls through to the ordinary unauthenticated handling.
        const res = makeRes();

        await authController.traefik(appSessionReq(OTHER_APP_HOST), res);

        expect(res.setHeader).not.toHaveBeenCalled();
        expect(forwardAuthSecrets.resolveForHost).not.toHaveBeenCalled();
        expect(userRepository.getUserDtoById).not.toHaveBeenCalled();
        expect(String((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('/api/auth/edge-sso');
      });

      it('does not sign on a host no app claims, even for a record that names no app', async () => {
        sessionManager.resolveAppSession.mockReturnValue({ userId: 7, parentSessionId: 'sid-1', appUrn: null } as never);
        const res = makeRes();

        await authController.traefik(appSessionReq('unmapped.ci.lan'), res);

        expect(res.setHeader).not.toHaveBeenCalled();
      });

      it('stops signing once the parent Hub session is logged out', async () => {
        // A real SessionManager behind the mock, so what refuses the second request is the cascade from
        // the parent session rather than a stubbed null.
        const real = new SessionManager(memoryCache() as never);
        const parent = await real.createSession(7);
        const appSessionId = (await real.createAppSession(7, parent, APP as never)) as string;
        sessionManager.resolveAppSession.mockImplementation((id: string) => real.resolveAppSession(id));
        const req = { ...appSessionReq(APP_HOST), cookies: { 'ci-hub-app-sid': appSessionId } } as unknown as Request;

        const before = makeRes();
        await authController.traefik(req, before);
        expect(signedHeaders(before)['X-CI-Hub-User']).toBe('op@example.com');

        // What `AuthService.logout` does with the session it is handed.
        await real.deleteSession(parent);

        const after = makeRes();
        await authController.traefik(req, after);
        expect(after.setHeader).not.toHaveBeenCalled();
        expect(after.status).not.toHaveBeenCalledWith(200);
      });

      it('wins over a Bearer the app sends for itself, as the Hub session it replaces did', async () => {
        // Judged Bearer-first, an app's own token would be read as a Portal id_token and every call 401.
        config.get.mockImplementation((key: string) => (key === 'ciCloudUrl' ? 'https://hub.ci.computer' : (undefined as never)));
        vi.mocked(verifyPortalIdToken).mockClear();
        vi.mocked(verifyPortalIdToken).mockResolvedValue(null);
        const res = makeRes();

        await authController.traefik(appSessionReq(APP_HOST, { headers: { authorization: 'Bearer app.own.jwt' } }), res);

        expect(verifyPortalIdToken).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(signedHeaders(res)['X-CI-Hub-User']).toBe('op@example.com');
      });

      it("carries the user's identity to a public path such as Memory's hub-bridge", async () => {
        // `/api/authenticate/hub-bridge` aligns Memory's own session to the signed Hub identity; the
        // anonymous pass-through for public paths would hand it none.
        const res = makeRes();

        await authController.traefik(appSessionReq(APP_HOST, { uri: '/api/authenticate/hub-bridge' }), res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(signedHeaders(res)['X-CI-Hub-User']).toBe('op@example.com');
      });

      it('burns a lingering ticket on a request its app session already authenticates', async () => {
        // A second tab entering the flow after the first tab's consume planted the cookie. A ticket left
        // live stays a replayable session-planting credential for the rest of its TTL.
        cache.get.mockReturnValue(JSON.stringify({ sessionId: 'sid-1' }));
        const res = makeRes();

        await authController.traefik(appSessionReq(APP_HOST, { uri: '/home?cihub_sso=t-9' }), res);

        expect(cache.del).toHaveBeenCalledWith('edge_sso:t-9');
        expect(res.redirect).toHaveBeenCalledWith(`https://${APP_HOST}/home`);
        expect(sessionManager.createAppSession).not.toHaveBeenCalled();
      });

      it("reads the user's row once and serves repeat requests from the session-user cache", async () => {
        // Forward auth runs for every asset and call an app makes; a row read per request is load the
        // Hub session this replaces never put on the database.
        await authController.traefik(appSessionReq(APP_HOST), makeRes());
        await authController.traefik(appSessionReq(APP_HOST), makeRes());

        expect(userRepository.getUserDtoById).toHaveBeenCalledTimes(1);
      });

      it('answers 503 rather than 500 when the user row stays unreachable', async () => {
        const transient = Object.assign(new Error('getaddrinfo EAI_AGAIN ci-hub-db'), { code: 'EAI_AGAIN' });
        userRepository.getUserDtoById.mockRejectedValue(transient);

        await expect(authController.traefik(appSessionReq(APP_HOST), makeRes())).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
        expect(userRepository.getUserDtoById).toHaveBeenCalledTimes(3);
      });

      it('carries on unauthenticated when the user row fails for a non-transient reason', async () => {
        userRepository.getUserDtoById.mockRejectedValue(new Error('Failed query: select id from user'));
        const res = makeRes();

        await authController.traefik(appSessionReq(APP_HOST), res);

        expect(res.setHeader).not.toHaveBeenCalled();
        expect(String((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('/api/auth/edge-sso');
      });
    });
  });

  describe('traefik — edge-SSO ticket consume', () => {
    // The two names for one app. Through the tunnel the browser is on the PUBLIC host while
    // cloudflared rewrites Host to the LAN origin server name, so the consume hop sees LAN_HOST
    // for a ticket minted against APP_HOST — the case that must work, and the one earlier
    // fixtures hid by putting the public name in x-forwarded-host.
    const APP_HOST = 'importer-core-2-org.companionintelligence.com';
    const LAN_HOST = 'importer-core-2-org.ci.lan';
    const TARGET = `https://${APP_HOST}/files?dir=%2Fdata`;

    /** A request as it actually arrives through the tunnel: rewritten Host, hop proto http, cf-ray. */
    const tunnelReq = (uri: string) =>
      ({
        user: undefined,
        headers: { 'cf-ray': 'ray-LAX', 'x-forwarded-uri': uri, 'x-forwarded-proto': 'http', 'x-forwarded-host': LAN_HOST },
        cookies: {},
      }) as unknown as Request;

    const consumeRes = () =>
      ({ status: vi.fn().mockReturnThis(), redirect: vi.fn(), cookie: vi.fn(), send: vi.fn(), setHeader: vi.fn() }) as unknown as Response;

    const APP = 'importer:ci-marketplace';

    const ticketFor = (over: Record<string, unknown> = {}) =>
      JSON.stringify({ sessionId: 'sid-1', targetHost: APP_HOST, targetUrl: TARGET, appUrn: APP, ...over });

    beforeEach(() => {
      config.get.mockImplementation((key: string) => {
        if (key === 'userSettings') return { experimental: { insecureCookie: false } } as never;
        return undefined as never;
      });
      config.getConfig.mockReturnValue({ domain: 'companionintelligence.com', localDomain: 'ci.lan' } as never);
      authService.getCookieDomain.mockImplementation((host?: string) => (host ? `.${host}` : undefined) as never);
      // The rewritten host resolves back to the app's public hostname.
      forwardAuthSecrets.resolvePublicHostForHost.mockResolvedValue(APP_HOST);
      // ...and the map vouches for it, so the edge-SSO hop will accept it as a redirect target.
      forwardAuthSecrets.resolveAppUrnForHost.mockResolvedValue(APP as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ hubSubdomain: 'hub-core-2-org', slug: 'org' } as never);
      sessionManager.createAppSession.mockResolvedValue('app-sid-1');
    });

    it('accepts a ticket bound to the PUBLIC host when the tunnel presents the rewritten LAN host', async () => {
      cache.get.mockReturnValue(ticketFor());
      sessionManager.resolveSessionUserId.mockReturnValue(7 as never);
      const res = consumeRes();

      await authController.traefik(tunnelReq('/files?dir=%2Fdata&cihub_sso=t-123'), res);

      expect(cache.del).toHaveBeenCalledWith('edge_sso:t-123'); // single use, burned before acting
      // The ticket's user, derived from the ticket's session, for the app this host resolves to — and
      // that app session is what lands on the app host, never the Hub session itself. Traefik copies
      // every request header to the app, and the Hub session is a full Hub API credential.
      expect(sessionManager.createAppSession).toHaveBeenCalledWith(7, 'sid-1', APP);
      // Exact options: host-only (no Domain), so there is nothing for the browser to fail to match
      // against the forwarded `.ci.lan` name, and no sibling or child host shares it.
      expect(res.cookie).toHaveBeenCalledTimes(1);
      expect(res.cookie).toHaveBeenCalledWith('ci-hub-app-sid', 'app-sid-1', {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      expect(authService.getCookieDomain).not.toHaveBeenCalled();
      // And the retry goes to the public URL — the `.ci.lan` name does not resolve for a remote
      // browser. Query encoding is preserved exactly.
      expect(res.redirect).toHaveBeenCalledWith(TARGET);
    });

    it('accepts a ticket on the LAN, where bound host and forwarded host coincide', async () => {
      const lanTarget = `http://${LAN_HOST}/files`;
      cache.get.mockReturnValue(ticketFor({ targetHost: LAN_HOST, targetUrl: lanTarget }));
      sessionManager.resolveSessionUserId.mockReturnValue(7 as never);
      const req = {
        user: undefined,
        headers: { 'x-forwarded-uri': '/files?cihub_sso=t-1', 'x-forwarded-proto': 'http', 'x-forwarded-host': LAN_HOST },
        cookies: {},
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      expect(res.redirect).toHaveBeenCalledWith(lanTarget);
      // http on the LAN: the cookie must not be flagged Secure or the browser discards it.
      expect(res.cookie).toHaveBeenCalledWith('ci-hub-app-sid', 'app-sid-1', expect.objectContaining({ secure: false }));
    });

    it("binds the app session to the forwarded host's app when another app still claims the ticket's host", async () => {
      // Two app rows can hold one custom domain (a stopped app keeps its binding), and the host map keeps
      // whichever registers last, so the mint can record the stale holder. Every later request on this
      // origin resolves to the app Traefik routes it to: a session bound to the ticket's app would be
      // refused on each of them and loop the visitor to the mint cap.
      const STALE_APP = 'wordpress:ci-marketplace';
      cache.get.mockReturnValue(ticketFor({ appUrn: STALE_APP }));
      sessionManager.resolveSessionUserId.mockReturnValue(7 as never);
      forwardAuthSecrets.resolveAppUrnForHost.mockImplementation(async (host) => (host === LAN_HOST ? APP : STALE_APP) as never);
      const res = consumeRes();

      await authController.traefik(tunnelReq('/files?dir=%2Fdata&cihub_sso=t-123'), res);

      expect(forwardAuthSecrets.resolveAppUrnForHost).toHaveBeenCalledWith(LAN_HOST);
      expect(sessionManager.createAppSession).toHaveBeenCalledWith(7, 'sid-1', APP);
      expect(res.redirect).toHaveBeenCalledWith(TARGET);
    });

    it('plants nothing for a ticket bound to a different app', async () => {
      // The sibling's public host is not what this forwarded host resolves to, so the binding
      // must reject even though both are legitimate apps on this appliance.
      cache.get.mockReturnValue(ticketFor({ targetHost: 'other-core-2-org.companionintelligence.com' }));
      sessionManager.resolveSessionUserId.mockReturnValue(7 as never);
      const res = consumeRes();

      await authController.traefik(tunnelReq('/?cihub_sso=t-123'), res);

      expect(cache.del).toHaveBeenCalledWith('edge_sso:t-123'); // still burned
      expect(sessionManager.createAppSession).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      const location = String((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location).toContain('/api/auth/edge-sso');
      expect(location).not.toContain('cihub_sso=');
    });

    it('plants nothing when the ticket outlived its session', async () => {
      cache.get.mockReturnValue(ticketFor({ sessionId: 'sid-dead' }));
      sessionManager.resolveSessionUserId.mockReturnValue(undefined as never);
      const res = consumeRes();

      await authController.traefik(tunnelReq('/?cihub_sso=t-123'), res);

      expect(sessionManager.createAppSession).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(String((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('/api/auth/edge-sso');
    });

    it('plants nothing for a ticket that names no app', async () => {
      // A ticket minted before tickets carried their app, or a malformed one: there is no app to scope
      // a session to, and a fresh mint is one redirect away.
      cache.get.mockReturnValue(ticketFor({ appUrn: undefined }));
      sessionManager.resolveSessionUserId.mockReturnValue(7 as never);
      const res = consumeRes();

      await authController.traefik(tunnelReq('/?cihub_sso=t-123'), res);

      expect(sessionManager.createAppSession).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(String((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('/api/auth/edge-sso');
    });

    it('plants nothing when no app session could be derived from the ticket session', async () => {
      // `createAppSession` refuses a parent with no life left — one that expired between the two reads.
      cache.get.mockReturnValue(ticketFor());
      sessionManager.resolveSessionUserId.mockReturnValue(7 as never);
      sessionManager.createAppSession.mockResolvedValue(null);
      const res = consumeRes();

      await authController.traefik(tunnelReq('/?cihub_sso=t-123'), res);

      expect(res.cookie).not.toHaveBeenCalled();
      expect(String((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('/api/auth/edge-sso');
    });

    it('treats an unknown ticket as a miss without a store write, and strips it from the return address', async () => {
      cache.get.mockReturnValue(undefined as never);
      const res = consumeRes();

      await authController.traefik(tunnelReq('/path?cihub_sso=forged'), res);

      // Unauthenticated endpoint: deleting on every miss would let a ticket flood force a
      // synchronous store write per bogus request (browser-handoff rationale).
      expect(cache.del).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      // A failed consume must not stack a second ticket onto the redirect target.
      expect(location.searchParams.get('redirect')).toBe(`https://${APP_HOST}/path`);
    });

    it('burns a lingering ticket when the request is already authenticated', async () => {
      // LAN fast path: the domain cookie authenticated the request before the ticket was ever
      // consumed. Leaving it live would keep a session-planting credential replayable from any
      // browser for the rest of its TTL.
      cache.get.mockReturnValue(ticketFor());
      const req = {
        user: { id: 1, username: 'op' },
        headers: { 'x-forwarded-uri': '/home?cihub_sso=t-9', 'x-forwarded-proto': 'https', 'x-forwarded-host': APP_HOST },
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      expect(cache.del).toHaveBeenCalledWith('edge_sso:t-9');
      expect(res.status).toHaveBeenCalledWith(302);
      // ABSOLUTE. Traefik does not hand a forward-auth Location back untouched: it resolves a
      // relative value against the AUTH-SERVER address, so `/home` would reach the browser as
      // `http://ci-os-hub:5002/home` — an internal name it cannot resolve.
      expect(res.redirect).toHaveBeenCalledWith(`https://${APP_HOST}/home`);
      expect(forwardAuthSecrets.resolveForHost).not.toHaveBeenCalled();
    });

    it('does not write to the store for a lingering ticket that was never minted', async () => {
      // Same flood rationale as the unauthenticated miss below: an unconditional delete lets
      // anyone holding a session force a synchronous store write per request by appending a junk
      // `cihub_sso=` — on the endpoint that runs for EVERY request to EVERY app.
      cache.get.mockReturnValue(undefined as never);
      const req = {
        user: { id: 1, username: 'op' },
        headers: { 'x-forwarded-uri': '/home?cihub_sso=forged', 'x-forwarded-proto': 'https', 'x-forwarded-host': APP_HOST },
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      expect(cache.del).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(`https://${APP_HOST}/home`);
    });

    it('strips a lingering ticket to an address the REMOTE browser can reach, not the rewritten LAN name', async () => {
      // Reachable remotely whenever a ticket-bearing request finds the cookie already planted —
      // e.g. a second tab entering the flow while the first tab's consume was in flight. The
      // forwarded host is the tunnel-rewritten `.ci.lan` origin server name, which does not
      // resolve off the LAN, so the public hostname is the only usable return address.
      cache.get.mockReturnValue(ticketFor());
      const req = {
        user: { id: 1, username: 'op' },
        headers: { 'cf-ray': 'ray-LAX', 'x-forwarded-uri': '/home?cihub_sso=t-9', 'x-forwarded-proto': 'http', 'x-forwarded-host': LAN_HOST },
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      expect(cache.del).toHaveBeenCalledWith('edge_sso:t-9');
      expect(res.redirect).toHaveBeenCalledWith(`https://${APP_HOST}/home`);
      expect(String((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).not.toContain(LAN_HOST);
    });

    it('serves the request instead of redirecting when no reachable return address is known', async () => {
      // Tunnel visitor whose forwarded host maps to no public hostname (host map behind a fresh
      // install, router created outside the app lifecycle). Neither candidate works: the `.ci.lan`
      // name does not resolve off the LAN, and a relative Location is the one shape Traefik
      // rewrites to its own internal address. The ticket is already burned, so tidying the URL is
      // cosmetic — keep the visitor on a page that works and let the stale param through.
      cache.get.mockReturnValue(ticketFor());
      forwardAuthSecrets.resolvePublicHostForHost.mockResolvedValue(null);
      forwardAuthSecrets.resolveForHost.mockResolvedValue({ secret: 's', appUrn: 'importer:ci-marketplace' as never, source: 'app-env' });
      const req = {
        user: { id: 1, username: 'op' },
        headers: { 'cf-ray': 'ray-LAX', 'x-forwarded-uri': '/home?cihub_sso=t-9', 'x-forwarded-proto': 'http', 'x-forwarded-host': LAN_HOST },
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      expect(cache.del).toHaveBeenCalledWith('edge_sso:t-9'); // still burned
      expect(res.redirect).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('pins the stripped target to the app host so an authority-shaped request path cannot escape it', async () => {
      // `//evil.com/` is a legal origin-form request target that reaches us intact through Go and
      // Express, and a browser reads `Location: //evil.com/` as protocol-relative. Any session
      // holder clicking `https://<app>//evil.com/?cihub_sso=x` would otherwise leave the appliance.
      cache.get.mockReturnValue(undefined as never);
      const req = {
        user: { id: 1, username: 'op' },
        headers: { 'x-forwarded-uri': '//evil.com/pwn?cihub_sso=x', 'x-forwarded-proto': 'https', 'x-forwarded-host': APP_HOST },
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      expect(new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).hostname).toBe(APP_HOST);
      expect(res.redirect).toHaveBeenCalledWith(`https://${APP_HOST}/evil.com/pwn`);
    });

    it('strips only the ticket, leaving the rest of the query byte-for-byte', async () => {
      // Stripping via `searchParams.delete` re-serialises the WHOLE query — `%20`→`+`, `~`→`%7E`,
      // bare `flag`→`flag=`. This cleaned URI is the address the browser lands on, so that
      // corruption would reach the app on every burned or failed ticket.
      const req = {
        user: { id: 1, username: 'op' },
        headers: {
          'x-forwarded-uri': '/search?q=a%20b&s=~z&flag&cihub_sso=t-9',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': APP_HOST,
        },
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      expect(res.redirect).toHaveBeenCalledWith(`https://${APP_HOST}/search?q=a%20b&s=~z&flag`);
    });

    it('strips EVERY ticket occurrence while reading only the first as the ticket', async () => {
      // A surviving duplicate strands the visitor permanently, not just for an extra hop: the mint
      // builds its target from this cleaned URI and appends the fresh ticket at the END, while the
      // consume reads the FIRST — so the stale one is what every consume looks up. It misses,
      // falls through to another mint, and three rounds later the loop guard serves its 409.
      cache.get.mockReturnValue(ticketFor());
      const req = {
        user: { id: 1, username: 'op' },
        headers: {
          'x-forwarded-uri': '/files?cihub_sso=t-first&keep=1&cihub_sso=t-second',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': APP_HOST,
        },
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      expect(cache.del).toHaveBeenCalledWith('edge_sso:t-first');
      expect(res.redirect).toHaveBeenCalledWith(`https://${APP_HOST}/files?keep=1`);
    });

    it('does not treat an unrelated param that merely ends in the ticket name as a ticket', async () => {
      // `?xcihub_sso=1` substring-matches `cihub_sso=` but is a DIFFERENT param. Treating it as a
      // lingering ticket "cleans" the URL to an identical string and redirects to itself forever.
      const req = {
        user: { id: 1, username: 'op' },
        headers: { 'x-forwarded-uri': '/home?xcihub_sso=1', 'x-forwarded-proto': 'https', 'x-forwarded-host': APP_HOST },
      } as unknown as Request;
      const res = consumeRes();
      forwardAuthSecrets.resolveForHost.mockResolvedValue({ secret: 's', source: 'global' });

      await authController.traefik(req, res);

      expect(res.redirect).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200); // signed pass-through, not a self-redirect
    });

    it('refuses a single-label forwarded host instead of crashing on an underivable hub origin', async () => {
      const req = {
        user: undefined,
        headers: { 'x-forwarded-uri': '/', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'localhost' },
        cookies: {},
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.redirect).not.toHaveBeenCalled();
    });

    it.each([
      // Lopping a label off an IPv4 literal yields `0.0.5`, which `new URL` silently re-expands to
      // the unrelated host `0.0.0.5` — a redirect to a machine that does not exist, with nothing
      // in the logs. The documented `https://<ip>:8443` tailnet path is exactly this shape.
      ['10.0.0.5:8443'],
      // The IPv6 form is worse: `0.0.5]:8443` contains a forbidden host code point, so `new URL`
      // THROWS — a 500 out of the forward-auth hop, i.e. the crash the single-label guard exists
      // to prevent.
      ['[::ffff:10.0.0.5]:8443'],
    ])('refuses the IP literal %s instead of inventing a hub origin from its trailing octets', async (host) => {
      const req = {
        user: undefined,
        headers: { 'x-forwarded-uri': '/', 'x-forwarded-proto': 'https', 'x-forwarded-host': host },
        cookies: {},
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.redirect).not.toHaveBeenCalled();
    });

    it('preserves a nonstandard port in both the hub origin and the return address on the LAN', async () => {
      // The documented :8443 tailnet path. Deriving these from the port-stripped key sends both
      // to :443, where nothing answers.
      const req = {
        user: undefined,
        headers: { 'x-forwarded-uri': '/x', 'x-forwarded-proto': 'https', 'x-forwarded-host': `${LAN_HOST}:8443` },
        cookies: {},
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location.origin).toBe('https://ci.lan:8443');
      expect(location.searchParams.get('redirect')).toBe(`https://${LAN_HOST}:8443/x`);
    });

    it('passes an untouched query through to the return address without re-encoding it', async () => {
      // URLSearchParams round-tripping rewrites %20 to '+', '~' to %7E and bare flags to 'flag=',
      // corrupting signature-checked or strictly-parsed query strings on the way back to the app.
      const req = {
        user: undefined,
        headers: { 'x-forwarded-uri': '/search?q=a%20b&s=~z&flag', 'x-forwarded-proto': 'https', 'x-forwarded-host': APP_HOST },
        cookies: {},
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location.searchParams.get('redirect')).toBe(`https://${APP_HOST}/search?q=a%20b&s=~z&flag`);
    });
  });

  describe('edge-sso', () => {
    const APP_HOST = 'importer-core-2-org.companionintelligence.com';
    const TARGET = `https://${APP_HOST}/files?dir=%2Fdata`;

    const ssoRes = () =>
      ({ status: vi.fn().mockReturnThis(), redirect: vi.fn(), type: vi.fn().mockReturnThis(), send: vi.fn() }) as unknown as Response;

    beforeEach(() => {
      config.getConfig.mockReturnValue({ localDomain: 'ci.lan' } as never);
      forwardAuthSecrets.resolveAppUrnForHost.mockResolvedValue('importer:ci-marketplace' as never);
    });

    it('rejects a target whose hostname no installed app claims', async () => {
      // The resolver host map is the allowlist: an exact membership check over this appliance's
      // own router hostnames, not a label heuristic — closing the open redirect.
      forwardAuthSecrets.resolveAppUrnForHost.mockResolvedValue(null);
      await expect(authController.edgeSso('https://evil.example.com/', { user: undefined } as never, ssoRes())).rejects.toThrow(
        'Unsupported edge SSO target',
      );
    });

    it('rejects a missing or unparsable target', async () => {
      await expect(authController.edgeSso(undefined, { user: undefined } as never, ssoRes())).rejects.toThrow();
      await expect(authController.edgeSso('not a url', { user: undefined } as never, ssoRes())).rejects.toThrow();
    });

    it('rejects loopback targets (local open never uses ticket SSO)', async () => {
      // ADR 001/002: localhost:{port} open must not mint a session-planting ticket.
      await expect(authController.edgeSso('http://localhost:3000/', { user: undefined } as never, ssoRes())).rejects.toThrow(
        'Unsupported edge SSO target',
      );
      await expect(authController.edgeSso('http://127.0.0.1:8080/files', { user: undefined } as never, ssoRes())).rejects.toThrow(
        'Unsupported edge SSO target',
      );
      expect(forwardAuthSecrets.resolveAppUrnForHost).not.toHaveBeenCalled();
    });

    it('rejects a repeated redirect param instead of minting for the comma-joined value', async () => {
      // Express hands a repeated query key to `@Query` as an ARRAY despite the `string | undefined`
      // annotation, and an array is truthy. `new URL(['https://app/', 'x'])` stringifies to
      // `https://app/,x`, whose hostname the allowlist vouches for — so this would mint a real
      // single-use ticket and bounce the browser to a corrupted path inside the app.
      await expect(authController.edgeSso([`https://${APP_HOST}/`, 'x'] as never, { user: undefined } as never, ssoRes())).rejects.toThrow();
    });

    it('allows plain http only under the appliance local domain', async () => {
      // LAN visitors legitimately arrive over http; a public sibling must never be handed a
      // downgraded scheme.
      await expect(authController.edgeSso(`http://${APP_HOST}/`, { user: undefined } as never, ssoRes())).rejects.toThrow();

      const res = ssoRes();
      const req = { user: undefined, headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'org.ci.lan' }, get: vi.fn() } as unknown as Request;
      await authController.edgeSso('http://importer-org.ci.lan/', req, res);
      expect(res.status).toHaveBeenCalledWith(302); // accepted → login redirect
    });

    it('sends an unauthenticated visitor to login with an absolute same-origin return address', async () => {
      const req = {
        user: undefined,
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'hub-core-2-org.companionintelligence.com' },
        get: vi.fn(),
      } as unknown as Request;
      const res = ssoRes();

      await authController.edgeSso(TARGET, req, res);

      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location.pathname).toBe('/login');
      // Absolute, on THIS origin: the portal OIDC callback only honors same-origin-absolute
      // redirect targets, and the login page must land back on this exact endpoint.
      const returnTo = new URL(location.searchParams.get('redirect_url') ?? '');
      expect(returnTo.origin).toBe('https://hub-core-2-org.companionintelligence.com');
      expect(returnTo.pathname).toBe('/api/auth/edge-sso');
      expect(returnTo.searchParams.get('redirect')).toBe(TARGET);
      expect(location.searchParams.get('app')).toBe('importer-core-2-org');
    });

    it('builds an https self-URL for a tunnel visitor even though the hop proto is http', async () => {
      // This endpoint is itself reached through the plain-HTTP tunnel entrypoint. An http
      // self-URL survives the round trip only to be rejected as cross-origin by the login page's
      // redirect check, silently stranding the visitor on /home.
      const req = {
        user: undefined,
        headers: { 'cf-ray': 'ray-LAX', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'hub-core-2-org.companionintelligence.com' },
        get: vi.fn(),
      } as unknown as Request;
      const res = ssoRes();

      await authController.edgeSso(TARGET, req, res);

      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location.protocol).toBe('https:');
      expect(new URL(location.searchParams.get('redirect_url') ?? '').protocol).toBe('https:');
    });

    it('treats a Bearer-authenticated request as having no session to hand off', async () => {
      // Bearer auth sets req.user but carries no session cookie — there is nothing to plant on
      // the app host, so the browser flow is the only way through.
      const req = {
        user: { id: 1, username: 'op' },
        cookies: {},
        get: vi.fn().mockReturnValue(undefined),
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'hub-core-2-org.companionintelligence.com' },
      } as unknown as Request;
      const res = ssoRes();

      await authController.edgeSso(TARGET, req, res);

      expect(String((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('/login');
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('mints a host-bound single-use ticket and bounces the browser back to the app', async () => {
      cache.get.mockReturnValue(undefined as never); // no prior mints
      const req = {
        user: { id: 1, username: 'op' },
        cookies: { 'ci-hub-sid': 'sid-9' },
        get: vi.fn().mockReturnValue(undefined),
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'hub-core-2-org.companionintelligence.com' },
      } as unknown as Request;
      const res = ssoRes();

      await authController.edgeSso(TARGET, req, res);

      const ticketCall = (cache.set as ReturnType<typeof vi.fn>).mock.calls.find(([key]) => String(key).startsWith('edge_sso:'));
      expect(ticketCall).toBeDefined();
      // The full target rides with the ticket: the consume hop cannot rebuild it from the
      // tunnel-rewritten forwarded host, which names the same app but is unreachable remotely.
      // So does the app that host resolves to, which is the only app the consumed ticket authenticates to.
      expect(JSON.parse(String(ticketCall?.[1]))).toEqual({
        sessionId: 'sid-9',
        targetHost: APP_HOST,
        targetUrl: TARGET,
        appUrn: 'importer:ci-marketplace',
      });
      expect(forwardAuthSecrets.resolveAppUrnForHost).toHaveBeenCalledWith(APP_HOST);
      expect(ticketCall?.[2]).toBe(60); // short-lived — the browser consumes it within one hop

      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location.hostname).toBe(APP_HOST);
      expect(location.pathname).toBe('/files');
      expect(location.searchParams.get('dir')).toBe('/data');
      expect(location.searchParams.get('cihub_sso')).toBe(String(ticketCall?.[0]).slice('edge_sso:'.length));
    });

    it('appends the ticket without re-encoding the app query', async () => {
      // `searchParams.set` re-serializes the WHOLE query — `%20`→`+`, `~`→`%7E`, bare `flag`→`flag=`
      // — the same corruption parseForwardedUri avoids, and it reaches the app whenever this hop's
      // URL is the one the browser ends up on (an already-authenticated ticket, or a failed consume).
      cache.get.mockReturnValue(undefined as never);
      const req = {
        user: { id: 1, username: 'op' },
        cookies: { 'ci-hub-sid': 'sid-9' },
        get: vi.fn().mockReturnValue(undefined),
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'hub-core-2-org.companionintelligence.com' },
      } as unknown as Request;
      const res = ssoRes();

      await authController.edgeSso(`https://${APP_HOST}/search?q=a%20b&s=~z&flag`, req, res);

      const ticketCall = (cache.set as ReturnType<typeof vi.fn>).mock.calls.find(([key]) => String(key).startsWith('edge_sso:'));
      const ticket = String(ticketCall?.[0]).slice('edge_sso:'.length);
      expect((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(`https://${APP_HOST}/search?q=a%20b&s=~z&flag&cihub_sso=${ticket}`);
    });

    it('breaks the redirect loop for a cookie-refusing browser instead of minting forever', async () => {
      cache.get.mockReturnValue('3' as never); // mint counter at the cap
      const req = {
        user: { id: 1, username: 'op' },
        cookies: { 'ci-hub-sid': 'sid-9' },
        get: vi.fn().mockReturnValue(undefined),
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'hub-core-2-org.companionintelligence.com' },
      } as unknown as Request;
      const res = ssoRes();

      await authController.edgeSso(TARGET, req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.redirect).not.toHaveBeenCalled();
      expect((cache.set as ReturnType<typeof vi.fn>).mock.calls.every(([key]) => !String(key).startsWith('edge_sso:'))).toBe(true);
    });
  });

  describe('exchangePortalDesktopLogin', () => {
    it('returns the cached desktop handoff once and plants the session cookie on the webview', async () => {
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'session-123', redirectPath: '/settings?tab=auth', userId: 1 }));
      sessionManager.resolveSessionUserId.mockReturnValue(1 as never);
      config.get.mockReturnValue({ experimental: { insecureCookie: true } });

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5005' : undefined)),
        headers: {},
        cookies: {},
      } as unknown as Request;
      const res = { cookie: vi.fn() } as unknown as Response;

      await expect(authController.exchangePortalDesktopLogin(req, res, 'desktop-token')).resolves.toEqual({
        sessionId: 'session-123',
        redirectPath: '/settings?tab=auth',
      });
      expect(cache.get).toHaveBeenCalledWith('portal_sso_desktop:desktop-token');
      expect(cache.del).toHaveBeenCalledWith('portal_sso_desktop:desktop-token');
      expect(res.cookie).toHaveBeenCalled();
    });

    it('mints a fresh session when the cached session id is gone', async () => {
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'session-stale', redirectPath: '/home', userId: 7 }));
      sessionManager.resolveSessionUserId.mockReturnValue(null as never);
      sessionManager.createSession.mockResolvedValue('session-fresh');
      config.get.mockReturnValue({ experimental: { insecureCookie: true } });

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5005' : undefined)),
        headers: {},
        cookies: {},
      } as unknown as Request;
      const res = { cookie: vi.fn() } as unknown as Response;

      await expect(authController.exchangePortalDesktopLogin(req, res, 'desktop-token')).resolves.toEqual({
        sessionId: 'session-fresh',
        redirectPath: '/home',
      });
      expect(sessionManager.createSession).toHaveBeenCalledWith(7);
    });
  });

  describe('refreshSession', () => {
    it('rotates the current session and returns a new id', async () => {
      authService.refreshSession.mockResolvedValue('session-next');
      config.get.mockReturnValue({ experimental: { insecureCookie: true } });

      const req = {
        cookies: {},
        get: vi.fn((header: string) => (header === 'x-ci-hub-session' ? 'session-old' : undefined)),
        headers: {},
      } as unknown as Request;
      const res = {
        cookie: vi.fn(),
      } as unknown as Response;

      const result = await authController.refreshSession(req, res);

      expect(authService.refreshSession).toHaveBeenCalledWith('session-old');
      expect(res.cookie).toHaveBeenCalled();
      expect(result.sessionId).toBe('session-next');
      expect(result.issuedAt).toEqual(expect.any(Number));
    });
  });

  describe('portalCallback', () => {
    it('redirects desktop flows to the cihub error deep link instead of returning JSON', async () => {
      cache.get.mockReturnValue(
        JSON.stringify({
          codeVerifier: 'verifier',
          redirectUrl: null,
          hubOrigin: 'http://localhost:5002',
          desktop: true,
        }),
      );
      config.get.mockReturnValue('https://hub.ci.computer');
      vi.mocked(exchangePortalAuthorizationCode).mockResolvedValue({
        ok: true,
        accessToken: 'access-token',
        email: 'operator@example.com',
        emailVerified: true,
        subject: 'portal-user-1',
        issuer: 'https://hub.ci.computer',
      });
      authService.admitHubPerson.mockRejectedValue(new Error('bootstrap failed'));

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5002' : undefined)),
        headers: {},
      } as unknown as Request;
      const res = {
        redirect: vi.fn(),
      } as unknown as Response;

      await authController.portalCallback(req, res, 'auth-code', 'state-123');

      expect(res.redirect).toHaveBeenCalledWith('cihub://auth?error=callback_error');
    });

    it('redirects browser flows to the login page with a portal_error query param', async () => {
      cache.get.mockReturnValue(null);
      config.get.mockReturnValue('https://hub.ci.computer');

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5002' : undefined)),
        headers: {},
      } as unknown as Request;
      const res = {
        redirect: vi.fn(),
      } as unknown as Response;

      await authController.portalCallback(req, res, 'auth-code', 'state-123');

      expect(res.redirect).toHaveBeenCalledWith('http://localhost:5002/login?portal_error=state_expired');
    });

    it('sends an HTML desktop handoff and does not return the Express response object', async () => {
      cache.get.mockReturnValue(
        JSON.stringify({
          codeVerifier: 'verifier',
          redirectUrl: null,
          hubOrigin: 'http://localhost:5005',
          desktop: true,
        }),
      );
      config.get.mockImplementation((key: string) => {
        if (key === 'ciCloudUrl') {
          return 'https://hub.ci.computer';
        }
        if (key === 'userSettings') {
          return { experimental: { insecureCookie: true } };
        }
        return '';
      });
      vi.mocked(exchangePortalAuthorizationCode).mockResolvedValue({
        ok: true,
        accessToken: 'access-token',
        email: 'operator@example.com',
        emailVerified: true,
        subject: 'portal-user-1',
        issuer: 'https://hub.ci.computer',
      });
      authService.admitHubPerson.mockResolvedValue({ id: 1, username: 'operator@example.com' } as never);
      sessionManager.createSession.mockResolvedValue('session-123');

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5005' : undefined)),
        headers: {},
        cookies: {},
      } as unknown as Request;
      const res = {
        redirect: vi.fn(),
        cookie: vi.fn(),
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
        send: vi.fn().mockReturnThis(),
      } as unknown as Response;

      const returned = await authController.portalCallback(req, res, 'auth-code', 'state-123');

      expect(returned).toBeUndefined();
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('cihub://auth?token='));
      expect(res.redirect).not.toHaveBeenCalled();
      expect(cache.set).toHaveBeenCalledWith(expect.stringMatching(/^portal_sso_desktop:/), expect.any(String), 60);
    });

    it('hands a loopback browser callback to the running Tauri app', async () => {
      cache.get.mockImplementation((key: string) => {
        if (key === 'portal_sso_desktop_present') {
          return '1';
        }
        return JSON.stringify({
          codeVerifier: 'verifier',
          redirectUrl: null,
          hubOrigin: 'http://localhost:5005',
          desktop: false,
        });
      });
      config.get.mockImplementation((key: string) => {
        if (key === 'ciCloudUrl') {
          return 'https://hub.ci.computer';
        }
        if (key === 'userSettings') {
          return { experimental: { insecureCookie: true } };
        }
        return '';
      });
      vi.mocked(exchangePortalAuthorizationCode).mockResolvedValue({
        ok: true,
        accessToken: 'access-token',
        email: 'operator@example.com',
        emailVerified: true,
        subject: 'portal-user-1',
        issuer: 'https://hub.ci.computer',
      });
      authService.admitHubPerson.mockResolvedValue({ id: 1, username: 'operator@example.com' } as never);
      sessionManager.createSession.mockResolvedValue('session-123');

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5005' : undefined)),
        headers: {},
        cookies: {},
      } as unknown as Request;
      const res = {
        redirect: vi.fn(),
        cookie: vi.fn(),
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
        send: vi.fn().mockReturnThis(),
      } as unknown as Response;

      await authController.portalCallback(req, res, 'auth-code', 'state-123');

      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('cihub://auth?token='));
      expect(res.redirect).not.toHaveBeenCalled();
    });
  });

  describe('startPortalLogin', () => {
    it('redirects desktop start failures to the cihub error deep link when CI Cloud is not configured', async () => {
      config.get.mockReturnValue('');

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5002' : undefined)),
        headers: {},
      } as unknown as Request;
      const res = {
        redirect: vi.fn(),
      } as unknown as Response;

      await authController.startPortalLogin(req, res, undefined, '1');

      expect(res.redirect).toHaveBeenCalledWith('cihub://auth?error=not_configured');
    });
  });

  describe('portalSessionHint', () => {
    it('returns the configured operator email when the hub is already set up', async () => {
      config.get.mockReturnValue('https://hub.ci.computer');
      vi.mocked(fetchPortalSessionEmail).mockResolvedValue(null);
      userRepository.getFirstOperator.mockResolvedValue({ id: 1, username: 'operator@example.com' } as never);

      await expect(
        authController.portalSessionHint({
          headers: {},
        } as Request),
      ).resolves.toEqual({
        email: 'operator@example.com',
        portalBaseUrl: 'https://hub.ci.computer',
        source: 'hub_operator',
      });
    });

    it('prefers a live Portal session over the Hub operator', async () => {
      config.get.mockReturnValue('https://hub.ci.computer');
      vi.mocked(fetchPortalSessionEmail).mockResolvedValue('hello@lifescope.io');
      userRepository.getFirstOperator.mockResolvedValue({ id: 1, username: 'operator@example.com' } as never);

      await expect(
        authController.portalSessionHint({
          headers: { cookie: 'ci.session_token=abc' },
        } as Request),
      ).resolves.toEqual({
        email: 'hello@lifescope.io',
        portalBaseUrl: 'https://hub.ci.computer',
        source: 'portal_session',
      });
    });

    it('prefers the current Hub session user over the first operator', async () => {
      config.get.mockReturnValue('https://hub.ci.computer');
      vi.mocked(fetchPortalSessionEmail).mockResolvedValue(null);
      userRepository.getFirstOperator.mockResolvedValue({ id: 1, username: 'operator@example.com' } as never);

      await expect(
        authController.portalSessionHint({
          headers: {},
          user: { username: 'hello@lifescope.io' },
        } as Request),
      ).resolves.toEqual({
        email: 'hello@lifescope.io',
        portalBaseUrl: 'https://hub.ci.computer',
        source: 'hub_user',
      });
    });

    it('records that the Tauri desktop app is running when desktop=1', async () => {
      config.get.mockReturnValue('https://hub.ci.computer');
      userRepository.getFirstOperator.mockResolvedValue({ id: 1, username: 'operator@example.com' } as never);

      await authController.portalSessionHint({ headers: {} } as Request, '1');

      expect(cache.set).toHaveBeenCalledWith('portal_sso_desktop_present', '1', 600);
    });

    it('bootstraps the session hint from Portal cookies when no operator exists yet', async () => {
      config.get.mockReturnValue('https://hub.ci.computer');
      userRepository.getFirstOperator.mockResolvedValue(null);
      vi.mocked(fetchPortalSessionEmail).mockResolvedValue('first@example.com');

      await expect(
        authController.portalSessionHint({
          headers: { cookie: 'ci.session=abc' },
        } as Request),
      ).resolves.toEqual({
        email: 'first@example.com',
        portalBaseUrl: 'https://hub.ci.computer',
        source: 'portal_session',
      });

      expect(fetchPortalSessionEmail).toHaveBeenCalledWith({
        publicPortalBaseUrl: 'https://hub.ci.computer',
        cookieHeader: 'ci.session=abc',
      });
    });

    it('creates the first operator during portal callback when none exists', async () => {
      cache.get.mockReturnValue(
        JSON.stringify({
          codeVerifier: 'verifier',
          redirectUrl: null,
          hubOrigin: 'http://localhost:5002',
          desktop: false,
        }),
      );
      config.get.mockImplementation((key: string) => {
        if (key === 'ciCloudUrl') {
          return 'https://hub.ci.computer';
        }
        if (key === 'userSettings') {
          return { experimental: { insecureCookie: true } };
        }
        return '';
      });
      vi.mocked(exchangePortalAuthorizationCode).mockResolvedValue({
        ok: true,
        accessToken: 'access-token',
        email: 'first@example.com',
        emailVerified: true,
        subject: 'portal-user-1',
        issuer: 'https://hub.ci.computer',
      });
      userRepository.getFirstOperator.mockResolvedValue(null);
      authService.admitHubPerson.mockResolvedValue({ id: 1, username: 'first@example.com' } as never);
      sessionManager.createSession.mockResolvedValue('session-123');

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5002' : undefined)),
        headers: {},
        cookies: {},
      } as unknown as Request;
      const res = {
        redirect: vi.fn(),
        cookie: vi.fn(),
      } as unknown as Response;

      await authController.portalCallback(req, res, 'auth-code', 'state-123');

      expect(authService.admitHubPerson).toHaveBeenCalledWith({
        issuer: 'https://hub.ci.computer',
        subject: 'portal-user-1',
        email: 'first@example.com',
        emailVerified: true,
      });
      expect(res.redirect).toHaveBeenCalledWith('http://localhost:5002/home');
    });

    it('refuses a Portal login that is not a member of this Hub org', async () => {
      /*
       * Strangers who merely have a Portal account must not become operators. Org membership
       * is the admission ticket; admitHubPerson throws AUTH_ERROR_NOT_ORG_MEMBER.
       */
      cache.get.mockReturnValue(
        JSON.stringify({
          codeVerifier: 'verifier',
          redirectUrl: null,
          hubOrigin: 'http://localhost:5002',
          desktop: false,
        }),
      );
      config.get.mockImplementation((key: string) => {
        if (key === 'ciCloudUrl') {
          return 'https://hub.ci.computer';
        }
        if (key === 'userSettings') {
          return { experimental: { insecureCookie: true } };
        }
        return '';
      });
      vi.mocked(exchangePortalAuthorizationCode).mockResolvedValue({
        ok: true,
        accessToken: 'access-token',
        email: 'companion@example.com',
        emailVerified: true,
        subject: 'portal-stranger',
        issuer: 'https://hub.ci.computer',
      });
      authService.admitHubPerson.mockRejectedValue(new TranslatableError('AUTH_ERROR_NOT_ORG_MEMBER', {}, 403));
      userRepository.updateUser.mockResolvedValue(true as never);
      sessionManager.createSession.mockResolvedValue('session-123');

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5002' : undefined)),
        headers: {},
        cookies: {},
      } as unknown as Request;
      const res = {
        redirect: vi.fn(),
        cookie: vi.fn(),
      } as unknown as Response;

      await authController.portalCallback(req, res, 'auth-code', 'state-123');

      // The operator row is untouched and no session is issued.
      expect(userRepository.updateUser).not.toHaveBeenCalled();
      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('not_org_member'));
    });

    it('sends a Portal outage to its own error code instead of blaming the account', async () => {
      // `not_org_member` renders "ask an admin to invite you". When the truth is that Portal was
      // unreachable, that sends the operator after a problem they do not have.
      cache.get.mockReturnValue(
        JSON.stringify({
          codeVerifier: 'verifier',
          redirectUrl: null,
          hubOrigin: 'http://localhost:5002',
          desktop: false,
        }),
      );
      config.get.mockImplementation((key: string) => {
        if (key === 'ciCloudUrl') {
          return 'https://hub.ci.computer';
        }
        if (key === 'userSettings') {
          return { experimental: { insecureCookie: true } };
        }
        return '';
      });
      vi.mocked(exchangePortalAuthorizationCode).mockResolvedValue({
        ok: true,
        accessToken: 'access-token',
        email: 'companion@example.com',
        emailVerified: true,
        subject: 'portal-person',
        issuer: 'https://hub.ci.computer',
      });
      authService.admitHubPerson.mockRejectedValue(new TranslatableError('AUTH_ERROR_ORG_CHECK_UNAVAILABLE', {}, 503));
      sessionManager.createSession.mockResolvedValue('session-123');

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5002' : undefined)),
        headers: {},
        cookies: {},
      } as unknown as Request;
      const res = { redirect: vi.fn(), cookie: vi.fn() } as unknown as Response;

      await authController.portalCallback(req, res, 'auth-code', 'state-123');

      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('org_check_unavailable'));
      expect(res.redirect).not.toHaveBeenCalledWith(expect.stringContaining('not_org_member'));
    });

    it('still signs a matching operator in on a plain browser callback', async () => {
      // The refusal above and the desktop handoff tests share this branch, so without this a
      // regression that refused EVERY browser login would leave the suite green.
      cache.get.mockReturnValue(
        JSON.stringify({
          codeVerifier: 'verifier',
          redirectUrl: null,
          hubOrigin: 'http://localhost:5002',
          desktop: false,
        }),
      );
      config.get.mockImplementation((key: string) => {
        if (key === 'ciCloudUrl') {
          return 'https://hub.ci.computer';
        }
        if (key === 'userSettings') {
          return { experimental: { insecureCookie: true } };
        }
        return '';
      });
      vi.mocked(exchangePortalAuthorizationCode).mockResolvedValue({
        ok: true,
        accessToken: 'access-token',
        email: 'Operator@Example.com',
        emailVerified: true,
        subject: 'portal-user-7',
        issuer: 'https://hub.ci.computer',
      });
      authService.admitHubPerson.mockResolvedValue({ id: 7, username: 'operator@example.com' } as never);
      sessionManager.createSession.mockResolvedValue('session-777');

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5002' : undefined)),
        headers: {},
        cookies: {},
      } as unknown as Request;
      const res = {
        redirect: vi.fn(),
        cookie: vi.fn(),
      } as unknown as Response;

      await authController.portalCallback(req, res, 'auth-code', 'state-123');

      expect(sessionManager.createSession).toHaveBeenCalledWith(7);
      expect(userRepository.updateUser).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('http://localhost:5002/home');
    });
  });

  describe('browser-handoff', () => {
    const hubOrigin = 'https://hub-core-2-myorg.companionintelligence.com';

    const mockHubOrigin = () => {
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ hubSubdomain: 'hub-core-2-myorg', slug: 'myorg' } as never);
      config.getConfig.mockReturnValue({ domain: 'companionintelligence.com', localDomain: 'ci.lan' } as never);
    };

    it('mints a single-use ticket bound to the caller session and returns a Hub handoff URL', async () => {
      mockHubOrigin();
      const req = {
        cookies: {},
        get: vi.fn((header: string) => (header === 'x-ci-hub-session' ? 'sess-1' : undefined)),
        headers: {},
      } as unknown as Request;

      const next = `${hubOrigin}/api/memory-connect/start?app=urn:store:ci-hermes`;
      const result = await authController.mintBrowserHandoff({ next }, req);

      expect(result.url).toEqual(
        expect.stringMatching(/^https:\/\/hub-core-2-myorg\.companionintelligence\.com\/api\/auth\/browser-handoff\?ticket=/),
      );
      expect(cache.set).toHaveBeenCalledTimes(1);
      const [key, value, ttl] = cache.set.mock.calls[0];
      expect(key).toMatch(/^browser_handoff:/);
      expect(JSON.parse(value as string)).toEqual({ sessionId: 'sess-1', next });
      expect(ttl).toBe(60);
    });

    it('accepts an app sibling origin under the public domain root as the target', async () => {
      mockHubOrigin();
      const req = { cookies: { 'ci-hub-sid': 'sess-2' }, get: vi.fn(), headers: {} } as unknown as Request;

      const result = await authController.mintBrowserHandoff({ next: 'https://ci-hermes-core-2-myorg.companionintelligence.com/' }, req);

      expect(result.url).toContain('/api/auth/browser-handoff?ticket=');
    });

    it('rejects an off-domain handoff target', async () => {
      mockHubOrigin();
      const req = { cookies: { 'ci-hub-sid': 'sess-3' }, get: vi.fn(), headers: {} } as unknown as Request;

      await expect(authController.mintBrowserHandoff({ next: 'https://evil.example/steal' }, req)).rejects.toThrow();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('rejects a co-tenant host on the shared registrable domain (different org slug)', async () => {
      mockHubOrigin();
      const req = { cookies: { 'ci-hub-sid': 'sess-3b' }, get: vi.fn(), headers: {} } as unknown as Request;

      // Same registrable domain, but a different org's `-<slug>` boundary — not one of
      // this appliance's own app hosts, so it must not be an accepted redirect target.
      await expect(
        authController.mintBrowserHandoff({ next: 'https://ci-hermes-core-9-attackerorg.companionintelligence.com/' }, req),
      ).rejects.toThrow();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('fails open with url:null when no public Hub origin is known yet', async () => {
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue(null as never);
      config.getConfig.mockReturnValue({ domain: 'example.com', localDomain: 'ci.lan' } as never);
      const req = { cookies: { 'ci-hub-sid': 'sess-4' }, get: vi.fn(), headers: {} } as unknown as Request;

      const result = await authController.mintBrowserHandoff({ next: `${hubOrigin}/x` }, req);

      expect(result.url).toBeNull();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('consume plants a DELEGATED session cookie and redirects to the stored next, consuming the ticket', async () => {
      mockHubOrigin();
      config.get.mockReturnValue({ experimental: { insecureCookie: true } } as never);
      const next = `${hubOrigin}/api/memory-connect/start?app=urn:store:ci-hermes`;
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'sess-1', next }));
      sessionManager.resolveSessionUserId.mockReturnValue(7 as never);
      sessionManager.createSession.mockResolvedValue('browser-sess');

      // The real desktop flow arrives as a user-initiated navigation (Sec-Fetch-Site: none).
      const req = { cookies: {}, get: vi.fn((h: string) => (h === 'sec-fetch-site' ? 'none' : undefined)), headers: {} } as unknown as Request;
      const res = { cookie: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.consumeBrowserHandoff('ticket-abc', req, res);

      expect(cache.get).toHaveBeenCalledWith('browser_handoff:ticket-abc');
      expect(cache.del).toHaveBeenCalledWith('browser_handoff:ticket-abc');
      // The browser must NOT receive the minting (desktop) session id: sharing one id
      // let the browser's first-load rotation delete the desktop's session (#944).
      expect(sessionManager.createSession).toHaveBeenCalledWith(7);
      expect(res.cookie).toHaveBeenCalledWith('ci-hub-sid', 'browser-sess', expect.objectContaining({ httpOnly: true }));
      expect(res.redirect).toHaveBeenCalledWith(next);
    });

    it('consume keeps a live session the browser already holds for the same user', async () => {
      mockHubOrigin();
      config.get.mockReturnValue({ experimental: { insecureCookie: true } } as never);
      const next = `${hubOrigin}/api/memory-connect/start?app=urn:store:ci-hermes`;
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'sess-1', next }));
      sessionManager.resolveSessionUserId.mockReturnValue(7 as never);
      sessionManager.touchSession.mockReturnValue(true);

      const req = {
        cookies: { 'ci-hub-sid': 'browser-already-here' },
        get: vi.fn((h: string) => (h === 'sec-fetch-site' ? 'none' : undefined)),
        headers: {},
      } as unknown as Request;
      const res = { cookie: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.consumeBrowserHandoff('ticket-abc', req, res);

      // Re-minting on every open would leave a trail of week-long sessions behind.
      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(sessionManager.touchSession).toHaveBeenCalledWith('browser-already-here');
      // The SAME id is re-planted: `touchSession` moved the server expiry, and the cookie's
      // own `maxAge` has to move with it or it dies mid-consent.
      expect(res.cookie).toHaveBeenCalledWith('ci-hub-sid', 'browser-already-here', expect.objectContaining({ httpOnly: true }));
      expect(res.redirect).toHaveBeenCalledWith(next);
    });

    it('consume replaces a browser session that is only in its rotation-grace window', async () => {
      mockHubOrigin();
      config.get.mockReturnValue({ experimental: { insecureCookie: true } } as never);
      const next = `${hubOrigin}/api/memory-connect/start?app=urn:store:ci-hermes`;
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'sess-1', next }));
      // resolveSessionUserId accepts grace ids; touchSession is what rejects them.
      sessionManager.resolveSessionUserId.mockReturnValue(7 as never);
      sessionManager.touchSession.mockReturnValue(false);
      sessionManager.createSession.mockResolvedValue('browser-sess');

      const req = {
        cookies: { 'ci-hub-sid': 'grace-id' },
        get: vi.fn((h: string) => (h === 'sec-fetch-site' ? 'none' : undefined)),
        headers: {},
      } as unknown as Request;
      const res = { cookie: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.consumeBrowserHandoff('ticket-abc', req, res);

      // Reusing it would hand the flow a cookie that dies part-way through consent.
      expect(sessionManager.createSession).toHaveBeenCalledWith(7);
      expect(res.cookie).toHaveBeenCalledWith('ci-hub-sid', 'browser-sess', expect.objectContaining({ httpOnly: true }));
      expect(res.redirect).toHaveBeenCalledWith(next);
    });

    it('consume replaces a session the browser holds for a DIFFERENT user', async () => {
      mockHubOrigin();
      config.get.mockReturnValue({ experimental: { insecureCookie: true } } as never);
      const next = `${hubOrigin}/api/memory-connect/start?app=urn:store:ci-hermes`;
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'sess-1', next }));
      sessionManager.resolveSessionUserId.mockImplementation(((id: string) => (id === 'sess-1' ? 7 : 9)) as never);
      sessionManager.createSession.mockResolvedValue('browser-sess');

      const req = {
        cookies: { 'ci-hub-sid': 'someone-elses-session' },
        get: vi.fn((h: string) => (h === 'sec-fetch-site' ? 'none' : undefined)),
        headers: {},
      } as unknown as Request;
      const res = { cookie: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.consumeBrowserHandoff('ticket-abc', req, res);

      expect(sessionManager.createSession).toHaveBeenCalledWith(7);
      expect(res.cookie).toHaveBeenCalledWith('ci-hub-sid', 'browser-sess', expect.objectContaining({ httpOnly: true }));
      expect(res.redirect).toHaveBeenCalledWith(next);
    });

    it('consume redirects home without delegating when the minting session died inside the ticket window', async () => {
      mockHubOrigin();
      const next = `${hubOrigin}/api/memory-connect/start?app=urn:store:ci-hermes`;
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'sess-gone', next }));
      sessionManager.resolveSessionUserId.mockReturnValue(null as never);

      const req = { cookies: {}, get: vi.fn((h: string) => (h === 'sec-fetch-site' ? 'none' : undefined)), headers: {} } as unknown as Request;
      const res = { cookie: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.consumeBrowserHandoff('ticket-abc', req, res);

      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/');
    });

    it.each([
      'cross-site',
      'same-site',
      'same-origin',
      // A spoofed multi-valued header (duplicate Sec-Fetch-Site joined by the runtime)
      // must not slip past the `=== 'none'` allow-list.
      'none, cross-site',
    ])('consume rejects a %s navigation without touching the ticket or setting a cookie', async (fetchSite) => {
      const req = { cookies: {}, get: vi.fn((h: string) => (h === 'sec-fetch-site' ? fetchSite : undefined)), headers: {} } as unknown as Request;
      const res = { cookie: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.consumeBrowserHandoff('ticket-abc', req, res);

      // Login-CSRF guard fires before the ticket is read, so a lured victim never
      // gets the attacker's session and the ticket is left intact.
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/');
    });

    it('consume redirects home for a missing/expired/replayed ticket without setting a cookie or writing', async () => {
      cache.get.mockReturnValue(undefined as never);
      const req = { cookies: {}, get: vi.fn(), headers: {} } as unknown as Request;
      const res = { cookie: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.consumeBrowserHandoff('gone', req, res);

      expect(res.cookie).not.toHaveBeenCalled();
      // A cache miss must not trigger a delete — this endpoint is unauthenticated, so a
      // per-miss SQLite write would be a flood amplifier.
      expect(cache.del).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/');
    });

    it('consume refuses a stored next that no longer passes validation', async () => {
      mockHubOrigin();
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'sess-1', next: 'https://evil.example/x' }));
      const req = { cookies: {}, get: vi.fn(), headers: {} } as unknown as Request;
      const res = { cookie: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.consumeBrowserHandoff('ticket-xyz', req, res);

      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/');
    });
  });

  /**
   * `cihub claim` — the headless way to create a Hub's first operator.
   *
   * The gap it closes: `cihub register` writes the device key and the organization id and stops. The
   * `user` row was only ever written by an interactive Portal login, and `POST /api/auth/register`
   * cannot finish unattended because Portal answers it with `requiresEmailVerification`. So a Hub
   * installed over SSH came up paired, keyed, and unable to authenticate its own operator API.
   *
   * These tests are about the three gates, because a claim route that is one gate short is a way in
   * rather than a way out: the host-local device key, a Hub that is actually paired, and no existing
   * operator. And about reuse: the row must come from `admitHubPerson`, so the rules on who may
   * become an operator have one home and cannot drift.
   */
  describe('POST /auth/hub/claim', () => {
    const claimReq = (over: Partial<Request> = {}) => ({ hubPrincipal: 'portal-device', ...over }) as unknown as Request;

    const keyOf = (error: unknown) => {
      const response = (error as TranslatableError).getResponse();
      return typeof response === 'object' && response ? (response as { message?: string }).message : String(response);
    };

    beforeEach(() => {
      config.get.mockReturnValue('org-1' as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      userRepository.getOperators.mockResolvedValue([] as never);
    });

    it('creates the first operator through admitHubPerson', async () => {
      authService.admitHubPerson.mockResolvedValue({ id: 1, username: 'owner@example.com' } as never);

      const result = await authController.claimHub({ email: 'Owner@Example.com' } as never, claimReq());

      expect(result).toEqual({ claimed: true, username: 'owner@example.com' });
      // Not a second user-creation path. `admitHubPerson` owns the first-operator bootstrap rule (the
      // one admission that skips the Portal membership check), so this route asks it rather than
      // writing a row of its own.
      expect(authService.admitHubPerson).toHaveBeenCalledWith({ issuer: '', subject: null, email: 'Owner@Example.com', emailVerified: false });
    });

    it('refuses a caller who did not present the host-local device key', async () => {
      // Pairing proves the ORG. The device key proves you are ON THE HUB — it lives in
      // state/settings.json, so presenting it means you could already read the Hub's credentials off
      // the disk. Without it this route would let anyone who can reach port 5002 own the appliance.
      for (const principal of [undefined, 'session', 'cli'] as const) {
        const error = await authController.claimHub({ email: 'a@b.co' } as never, claimReq({ hubPrincipal: principal })).catch((err) => err);

        expect(keyOf(error)).toBe('AUTH_ERROR_HUB_CLAIM_REQUIRES_DEVICE_KEY');
        expect((error as TranslatableError).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      }
      expect(authService.admitHubPerson).not.toHaveBeenCalled();
    });

    it.each([
      ['no device registration row', null, 'org-1'],
      ['no organization id in settings', { id: 'org-1' }, null],
    ])('refuses a Hub that is not registered: %s', async (_label, registration, orgId) => {
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue(registration as never);
      config.get.mockReturnValue(orgId as never);

      const error = await authController.claimHub({ email: 'a@b.co' } as never, claimReq()).catch((err) => err);

      expect(keyOf(error)).toBe('AUTH_ERROR_HUB_NOT_REGISTERED');
      expect((error as TranslatableError).getStatus()).toBe(HttpStatus.CONFLICT);
      expect(authService.admitHubPerson).not.toHaveBeenCalled();
    });

    it('refuses a second operator, and says which condition refused it', async () => {
      // The whole safety of the bootstrap is that it happens ONCE: after the first operator exists,
      // everyone else goes through Portal and gets membership-checked. A claim that could run twice
      // would be a standing way to mint an unchecked operator on a working appliance.
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'owner@example.com' }] as never);

      const error = await authController.claimHub({ email: 'someone-else@example.com' } as never, claimReq()).catch((err) => err);

      expect(keyOf(error)).toBe('AUTH_ERROR_HUB_ALREADY_CLAIMED');
      expect((error as TranslatableError).getStatus()).toBe(HttpStatus.CONFLICT);
      expect(authService.admitHubPerson).not.toHaveBeenCalled();
    });

    it('is idempotent for the address that already holds the Hub', async () => {
      // Re-running an installer must not create a second row, and must not silently succeed either:
      // the refusal is the same one, and it is what lets `cihub claim` exit 0 without acting.
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'owner@example.com' }] as never);

      const error = await authController.claimHub({ email: 'owner@example.com' } as never, claimReq()).catch((err) => err);

      expect(keyOf(error)).toBe('AUTH_ERROR_HUB_ALREADY_CLAIMED');
      expect(authService.admitHubPerson).not.toHaveBeenCalled();
    });
  });

  describe('GET /auth/hub/claim', () => {
    it('reports the operator count and whether the Hub is paired', async () => {
      userRepository.getOperators.mockResolvedValue([{ id: 1 }, { id: 2 }] as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      config.get.mockReturnValue('org-1' as never);

      await expect(authController.hubClaimStatus({ hubPrincipal: 'portal-device' } as unknown as Request)).resolves.toEqual({
        claimed: true,
        operators: 2,
        registered: true,
      });
    });

    it('separates "no operator" from "not registered", which need different next steps', async () => {
      userRepository.getOperators.mockResolvedValue([] as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue(null as never);
      config.get.mockReturnValue(null as never);

      await expect(authController.hubClaimStatus({ hubPrincipal: 'portal-device' } as unknown as Request)).resolves.toEqual({
        claimed: false,
        operators: 0,
        registered: false,
      });
    });

    it('does not tell an unkeyed caller whether this appliance has an owner', async () => {
      // "This Hub has nobody on it" is the first sentence of an attack plan, and the only caller that
      // needs it — `cihub doctor` on the box — already holds the key.
      await expect(authController.hubClaimStatus({} as unknown as Request)).rejects.toBeInstanceOf(TranslatableError);
      expect(userRepository.getOperators).not.toHaveBeenCalled();
    });
  });
});
