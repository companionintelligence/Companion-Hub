import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';

describe('AuthController', () => {
  let authController: AuthController;
  let authService: MockProxy<AuthService>;
  let logger: MockProxy<LoggerService>;
  let config: MockProxy<ConfigurationService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mock<AuthService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
      ],
    }).compile();

    authController = moduleRef.get(AuthController);
    authService = moduleRef.get(AuthService);
    logger = moduleRef.get(LoggerService);
    config = moduleRef.get(ConfigurationService);
  });

  it('should be defined', () => {
    expect(authController).toBeDefined();
  });

  describe('traefik', () => {
    it('should return 200 with X-CI-Hub-User header when user is authenticated', async () => {
      // Arrange
      const mockUser = { id: 1, username: 'testuser' };
      const req = {
        user: mockUser,
      } as unknown as Request;

      const res = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
        setHeader: vi.fn(),
      } as unknown as Response;

      // Act
      await authController.traefik(req, res);

      // Assert
      expect(res.setHeader).toHaveBeenCalledWith('X-CI-Hub-User', 'testuser');
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

  describe('setSessionCookie (via login)', () => {
    it('should use sameSite lax with secure false when insecureCookie is enabled', async () => {
      config.get.mockImplementation((key: string) => {
        if (key === 'userSettings') return { experimental: { insecureCookie: true } };
        return undefined;
      });
      authService.login.mockResolvedValue({ sessionId: 'test-session-id', totpSessionId: undefined as unknown as string });

      const req = { headers: {}, cookies: {} } as unknown as Request;
      const cookieFn = vi.fn();
      const res = {
        cookie: cookieFn,
      } as unknown as Response;

      await authController.login({ username: 'u', password: 'p' }, res, req);

      expect(cookieFn).toHaveBeenCalledWith(
        SESSION_COOKIE_NAME,
        'test-session-id',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'lax' }),
      );
    });

    it('should NOT use sameSite none (which requires secure) for insecure cookie mode', async () => {
      config.get.mockImplementation((key: string) => {
        if (key === 'userSettings') return { experimental: { insecureCookie: true } };
        return undefined;
      });
      authService.login.mockResolvedValue({ sessionId: 'test-session-id', totpSessionId: undefined as unknown as string });

      const req = { headers: {}, cookies: {} } as unknown as Request;
      const cookieFn = vi.fn();
      const res = { cookie: cookieFn } as unknown as Response;

      await authController.login({ username: 'u', password: 'p' }, res, req);

      const cookieOptions = cookieFn.mock.calls[0]?.[2];
      expect(cookieOptions?.sameSite).not.toBe('none');
    });
  });

  describe('logout', () => {
    it('should invalidate session from cookie', async () => {
      const req = {
        cookies: { [SESSION_COOKIE_NAME]: 'cookie-session-id' },
        headers: {},
      } as unknown as Request;
      const res = {
        clearCookie: vi.fn(),
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as Response;

      await authController.logout(res, req);

      expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
      expect(authService.logout).toHaveBeenCalledWith('cookie-session-id');
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('should invalidate session from x-ci-hub-session header when cookie is absent', async () => {
      const req = {
        cookies: {},
        headers: { 'x-ci-hub-session': 'header-session-id' },
      } as unknown as Request;
      const res = {
        clearCookie: vi.fn(),
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as Response;

      await authController.logout(res, req);

      expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
      expect(authService.logout).toHaveBeenCalledWith('header-session-id');
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('should prefer cookie session over header session', async () => {
      const req = {
        cookies: { [SESSION_COOKIE_NAME]: 'cookie-session-id' },
        headers: { 'x-ci-hub-session': 'header-session-id' },
      } as unknown as Request;
      const res = {
        clearCookie: vi.fn(),
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as Response;

      await authController.logout(res, req);

      expect(authService.logout).toHaveBeenCalledWith('cookie-session-id');
    });

    it('should return 204 when no session is found', async () => {
      const req = {
        cookies: {},
        headers: {},
      } as unknown as Request;
      const res = {
        clearCookie: vi.fn(),
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as Response;

      await authController.logout(res, req);

      expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
      expect(authService.logout).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(204);
    });
  });
});
