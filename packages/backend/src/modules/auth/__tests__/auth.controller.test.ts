import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
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
    it('should return 200 with X-Runtipi-User header when user is authenticated', async () => {
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
      expect(res.setHeader).toHaveBeenCalledWith('X-Runtipi-User', 'testuser');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith('User authenticated for Traefik forward auth', { username: 'testuser' });
    });

    it('should return 401 when user is not authenticated', async () => {
      // Arrange
      const req = {
        user: undefined,
      } as unknown as Request;

      const res = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as Response;

      // Act
      await authController.traefik(req, res);

      // Assert
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith('Unauthorized');
      expect(logger.debug).toHaveBeenCalledWith('User not authenticated for Traefik forward auth');
    });
  });
});
