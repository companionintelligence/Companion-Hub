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
  let cache: MockProxy<CacheService>;
  let userRepository: MockProxy<UserRepository>;
  let sessionManager: MockProxy<SessionManager>;
  let deviceRegistration: MockProxy<DeviceRegistrationRepository>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mock<AuthService>() },
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
      // Arrange
      config.get.mockImplementation((key: string) => (key === 'forwardAuthSecret' ? 'shared-secret' : undefined) as never);
      const mockUser = { id: 1, username: 'testuser' };
      const req = {
        user: mockUser,
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
      // signature verifies against the shared secret and canonical message.
      expect(setHeader).toHaveBeenCalledWith('X-CI-Hub-User', 'testuser');
      const headers = Object.fromEntries(setHeader.mock.calls);
      const timestamp = Number(headers['X-CI-Hub-User-Timestamp']);
      expect(Number.isFinite(timestamp)).toBe(true);
      expect(headers['X-CI-Hub-User-Signature']).toBe(signForwardAuthUser('shared-secret', 'testuser', timestamp));

      // A signature computed with any other secret must NOT match — this is what
      // stops a container on ci_os_hub_network forging the identity header.
      expect(headers['X-CI-Hub-User-Signature']).not.toBe(signForwardAuthUser('wrong-secret', 'testuser', timestamp));

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith('User authenticated for Traefik forward auth', { username: 'testuser' });
    });

    it('should redirect to login when user is not authenticated', async () => {
      // Arrange
      const req = {
        user: undefined,
        headers: {
          'x-forwarded-uri': '/dashboard',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'jellyfin-myorg.companionintelligence.com',
        },
      } as unknown as Request;

      const res = {
        status: vi.fn().mockReturnThis(),
        redirect: vi.fn(),
      } as unknown as Response;

      // Act
      await authController.traefik(req, res);

      // Assert
      expect(res.status).toHaveBeenCalledWith(302);
      expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('companionintelligence.com/login'));
      expect(logger.debug).toHaveBeenCalledWith(
        'Unauthenticated Traefik forward auth request',
        expect.objectContaining({ host: 'jellyfin-myorg.companionintelligence.com' }),
      );
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
