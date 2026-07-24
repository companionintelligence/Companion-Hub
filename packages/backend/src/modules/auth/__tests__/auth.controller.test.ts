import { CacheService } from '@/core/cache/cache.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { UserRepository } from '@/modules/user/user.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AuthController } from '../auth.controller';
import { ForwardAuthSecretResolver } from '../forward-auth-secret.resolver';
import { AuthService } from '../auth.service';
import { exchangePortalAuthorizationCode, fetchPortalSessionEmail } from '../portal-sso';
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
  });

  it('should be defined', () => {
    expect(authController).toBeDefined();
  });

  describe('traefik', () => {
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
      forwardAuthSecrets.resolveForHost.mockResolvedValue({ secret: 'global-secret', source: 'global' });
      const req = { user: { id: 1, username: 'testuser' }, headers: {} } as unknown as Request;
      const setHeader = vi.fn();
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), setHeader } as unknown as Response;

      await authController.traefik(req, res);

      const headers = Object.fromEntries(setHeader.mock.calls);
      const timestamp = Number(headers['X-CI-Hub-User-Timestamp']);
      expect(headers['X-CI-Hub-User-Signature']).toBe(signForwardAuthUser('global-secret', 'testuser', timestamp));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('routes an unauthenticated LAN visitor into edge-sso on the derived root-domain origin', async () => {
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

    it('refuses a request with no forwarded host instead of crashing', async () => {
      // The old code called host.split(...) on undefined — a 500 the visitor saw as a server
      // error. A forward-auth subrequest with no forwarded host has nothing to route back to.
      const req = { user: undefined, headers: { 'x-forwarded-uri': '/', 'x-forwarded-proto': 'https' } } as unknown as Request;
      const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.redirect).not.toHaveBeenCalled();
    });
  });

  describe('traefik — edge-SSO ticket consume', () => {
    const APP_HOST = 'importer-core-2-org.companionintelligence.com';

    const consumeReq = (uri: string) =>
      ({
        user: undefined,
        headers: { 'x-forwarded-uri': uri, 'x-forwarded-proto': 'https', 'x-forwarded-host': APP_HOST },
        cookies: {},
      }) as unknown as Request;

    const consumeRes = () => ({ status: vi.fn().mockReturnThis(), redirect: vi.fn(), cookie: vi.fn(), send: vi.fn() }) as unknown as Response;

    beforeEach(() => {
      // setSessionCookie dependencies for the consume path.
      config.get.mockImplementation((key: string) => {
        if (key === 'userSettings') return { experimental: { insecureCookie: false } } as never;
        return undefined as never;
      });
      authService.getCookieDomain.mockReturnValue(`.${APP_HOST}`);
    });

    it('plants the session cookie on the app host and retries the clean URL for a valid ticket', async () => {
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'sid-1', targetHost: APP_HOST }));
      sessionManager.resolveSessionUserId.mockReturnValue(7 as never);
      const res = consumeRes();

      await authController.traefik(consumeReq('/files?dir=%2Fdata&cihub_sso=t-123'), res);

      // Burned before acted on — single use.
      expect(cache.del).toHaveBeenCalledWith('edge_sso:t-123');
      expect(res.cookie).toHaveBeenCalledWith('ci-hub-sid', 'sid-1', expect.objectContaining({ httpOnly: true }));
      expect(res.status).toHaveBeenCalledWith(302);
      // The retry URL is the forwarded URL minus the ticket — it must never reach the app.
      expect(res.redirect).toHaveBeenCalledWith(`https://${APP_HOST}/files?dir=%2Fdata`);
    });

    it('plants nothing for a ticket bound to a different host', async () => {
      // A ticket minted for one app must not plant a cookie on a sibling that lured it.
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'sid-1', targetHost: 'other-app.companionintelligence.com' }));
      sessionManager.resolveSessionUserId.mockReturnValue(7 as never);
      const res = consumeRes();

      await authController.traefik(consumeReq('/?cihub_sso=t-123'), res);

      expect(cache.del).toHaveBeenCalledWith('edge_sso:t-123'); // still burned
      expect(res.cookie).not.toHaveBeenCalled();
      // Falls through to a fresh edge-sso redirect rather than dead-ending.
      const location = String((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location).toContain('/api/auth/edge-sso');
      expect(location).not.toContain('cihub_sso=');
    });

    it('plants nothing when the ticket outlived its session', async () => {
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'sid-dead', targetHost: APP_HOST }));
      sessionManager.resolveSessionUserId.mockReturnValue(undefined as never);
      const res = consumeRes();

      await authController.traefik(consumeReq('/?cihub_sso=t-123'), res);

      expect(res.cookie).not.toHaveBeenCalled();
      expect(String((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('/api/auth/edge-sso');
    });

    it('treats an unknown ticket as a miss without a store write, and strips it from the return address', async () => {
      cache.get.mockReturnValue(undefined as never);
      const res = consumeRes();

      await authController.traefik(consumeReq('/path?cihub_sso=forged'), res);

      // Unauthenticated endpoint: deleting on every miss would let a ticket flood force a
      // synchronous store write per bogus request (browser-handoff rationale).
      expect(cache.del).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      // A failed consume must not stack a second ticket onto the redirect target.
      expect(location.searchParams.get('redirect')).toBe(`https://${APP_HOST}/path`);
    });

    it('strips a lingering ticket with a clean redirect when already authenticated', async () => {
      // LAN fast path: the domain cookie authenticated the request before the ticket was ever
      // consumed. The credential-bearing URL must not reach the app.
      const req = {
        user: { id: 1, username: 'op' },
        headers: { 'x-forwarded-uri': '/home?cihub_sso=t-9', 'x-forwarded-proto': 'https', 'x-forwarded-host': APP_HOST },
      } as unknown as Request;
      const res = consumeRes();

      await authController.traefik(req, res);

      expect(res.status).toHaveBeenCalledWith(302);
      expect(res.redirect).toHaveBeenCalledWith(`https://${APP_HOST}/home`);
      expect(forwardAuthSecrets.resolveForHost).not.toHaveBeenCalled();
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
      expect(JSON.parse(String(ticketCall?.[1]))).toEqual({ sessionId: 'sid-9', targetHost: APP_HOST });
      expect(ticketCall?.[2]).toBe(60); // short-lived — the browser consumes it within one hop

      const location = new URL((res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(location.hostname).toBe(APP_HOST);
      expect(location.pathname).toBe('/files');
      expect(location.searchParams.get('dir')).toBe('/data');
      expect(location.searchParams.get('cihub_sso')).toBe(String(ticketCall?.[0]).slice('edge_sso:'.length));
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
    it('returns the cached desktop handoff once', async () => {
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'session-123', redirectPath: '/settings?tab=auth' }));

      await expect(authController.exchangePortalDesktopLogin('desktop-token')).resolves.toEqual({
        sessionId: 'session-123',
        redirectPath: '/settings?tab=auth',
      });
      expect(cache.get).toHaveBeenCalledWith('portal_sso_desktop:desktop-token');
      expect(cache.del).toHaveBeenCalledWith('portal_sso_desktop:desktop-token');
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
      });
      userRepository.getFirstOperator.mockResolvedValue(null);
      authService.bootstrapOperatorFromPortalEmail.mockRejectedValue(new Error('bootstrap failed'));

      const req = {
        protocol: 'http',
        get: vi.fn((header: string) => (header === 'host' ? 'localhost:5002' : undefined)),
        headers: {},
      } as unknown as Request;
      const res = {
        redirect: vi.fn(),
      } as unknown as Response;

      await authController.portalCallback(req, res, 'auth-code', 'state-123');

      expect(res.redirect).toHaveBeenCalledWith('cihub-dev://auth?error=callback_error');
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

      expect(res.redirect).toHaveBeenCalledWith('cihub-dev://auth?error=not_configured');
    });
  });

  describe('portalSessionHint', () => {
    it('returns the configured operator email when the hub is already set up', async () => {
      config.get.mockReturnValue('https://hub.ci.computer');
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
      });
      userRepository.getFirstOperator.mockResolvedValue(null);
      authService.bootstrapOperatorFromPortalEmail.mockResolvedValue({ id: 1, username: 'first@example.com' } as never);
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

      expect(authService.bootstrapOperatorFromPortalEmail).toHaveBeenCalledWith('first@example.com');
      expect(res.redirect).toHaveBeenCalledWith('http://localhost:5002/home');
    });

    it('syncs the sole local operator email from a verified Portal login when they differ', async () => {
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
      });
      userRepository.getFirstOperator.mockResolvedValue({ id: 1, username: 'admin@local.test' } as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'admin@local.test' }] as never);
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

      expect(userRepository.updateUser).toHaveBeenCalledWith(1, { username: 'companion@example.com' });
      expect(sessionManager.createSession).toHaveBeenCalledWith(1);
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

    it('consume plants the session cookie and redirects to the stored next, consuming the ticket', async () => {
      mockHubOrigin();
      config.get.mockReturnValue({ experimental: { insecureCookie: true } } as never);
      const next = `${hubOrigin}/api/memory-connect/start?app=urn:store:ci-hermes`;
      cache.get.mockReturnValue(JSON.stringify({ sessionId: 'sess-1', next }));

      // The real desktop flow arrives as a user-initiated navigation (Sec-Fetch-Site: none).
      const req = { cookies: {}, get: vi.fn((h: string) => (h === 'sec-fetch-site' ? 'none' : undefined)), headers: {} } as unknown as Request;
      const res = { cookie: vi.fn(), redirect: vi.fn() } as unknown as Response;

      await authController.consumeBrowserHandoff('ticket-abc', req, res);

      expect(cache.get).toHaveBeenCalledWith('browser_handoff:ticket-abc');
      expect(cache.del).toHaveBeenCalledWith('browser_handoff:ticket-abc');
      expect(res.cookie).toHaveBeenCalledWith('ci-hub-sid', 'sess-1', expect.objectContaining({ httpOnly: true }));
      expect(res.redirect).toHaveBeenCalledWith(next);
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
});
