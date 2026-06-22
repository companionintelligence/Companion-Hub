import { CacheService } from '@/core/cache/cache.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { UserRepository } from '@/modules/user/user.repository';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { SessionManager } from '../session.manager';

describe('AuthController', () => {
  let authController: AuthController;
  let _authService: MockProxy<AuthService>;
  let logger: MockProxy<LoggerService>;
  let _config: MockProxy<ConfigurationService>;
  let cache: MockProxy<CacheService>;

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
      ],
    }).compile();

    authController = moduleRef.get(AuthController);
    _authService = moduleRef.get(AuthService);
    logger = moduleRef.get(LoggerService);
    _config = moduleRef.get(ConfigurationService);
    cache = moduleRef.get(CacheService);
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
});
