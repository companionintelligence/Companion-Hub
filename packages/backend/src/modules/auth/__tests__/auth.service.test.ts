import { CacheService } from '@/core/cache/cache.service';
import { PasswordService } from '@/core/password/password.service';
import { UserRepository } from '@/modules/user/user.repository';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AuthService } from '../auth.service';
import { SessionManager } from '../session.manager';
import type { LoginBody } from '../dto/auth.dto';

describe('AuthService', () => {
  let authService: AuthService;
  let userRepository: MockProxy<UserRepository>;
  let passwordService: MockProxy<PasswordService>;
  let sessionManager: MockProxy<SessionManager>;
  let cacheService: MockProxy<CacheService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserRepository, useValue: mock<UserRepository>() },
        { provide: PasswordService, useValue: mock<PasswordService>() },
        { provide: SessionManager, useValue: mock<SessionManager>() },
        { provide: CacheService, useValue: mock<CacheService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: EncryptionService, useValue: mock<EncryptionService>() },
        { provide: FilesystemService, useValue: mock<FilesystemService>() },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
    userRepository = moduleRef.get(UserRepository);
    passwordService = moduleRef.get(PasswordService);
    sessionManager = moduleRef.get(SessionManager);
    cacheService = moduleRef.get(CacheService);
  });

  it('should be defined', () => {
    expect(authService).toBeDefined();
  });

  describe('login', () => {
    it('should return sessionId for valid credentials', async () => {
      // Arrange
      const loginBody: LoginBody = { username: 'testuser', password: 'password' };
      const mockUser = { id: 1, password: 'hashedPassword', totpEnabled: false };

      userRepository.getUserByUsername.calledWith('testuser').mockResolvedValue(mockUser as any);
      passwordService.verify.mockResolvedValue(true);
      sessionManager.createSession.mockResolvedValue('session-id' as any);

      // Act
      const result = await authService.login(loginBody);

      // Assert
      expect(result).toEqual({ sessionId: 'session-id' });
      expect(userRepository.getUserByUsername).toHaveBeenCalledWith('testuser');
      expect(passwordService.verify).toHaveBeenCalledWith('password', 'hashedPassword');
      expect(sessionManager.createSession).toHaveBeenCalledWith(1);
    });

    it('should return totpSessionId if totp is enabled', async () => {
      // Arrange
      const loginBody: LoginBody = { username: 'totpuser', password: 'password' };
      // Use 1 to simulate truthy value if boolean mapping is issue
      const mockUser = { id: 2, password: 'hashedPassword', totpEnabled: 1 };

      userRepository.getUserByUsername.calledWith('totpuser').mockResolvedValue(mockUser as any);
      passwordService.verify.mockResolvedValue(true);

      // Act
      const result = await authService.login(loginBody);

      // Assert
      expect(result).toHaveProperty('totpSessionId');
      expect(cacheService.set).toHaveBeenCalled();
      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });
  });

  describe('getCookieDomain', () => {
    it('should return undefined if the domain is localhost', async () => {
      const domain = 'localhost';
      const result = await authService.getCookieDomain(domain);
      expect(result).toBeUndefined();
    });

    it('should return undefined if the domain is an IP address', async () => {
      const domain = '192.168.3.20';
      const result = await authService.getCookieDomain(domain);
      expect(result).toBeUndefined();
    });

    it('should return with subdomain', async () => {
      const domain = 'example.duckdns.org';
      const result = await authService.getCookieDomain(domain);

      expect(result).toBe(`.${domain}`);
    });

    it('should return input if domain is not using a standard tld', async () => {
      const domain = 'example.whatever';
      const result = await authService.getCookieDomain(domain);

      expect(result).toBe(`.${domain}`);
    });

    it('should return all subdomains when using multiple levels of subdomains', async () => {
      const domain = 'sub.sub.duckdns.org';
      const result = await authService.getCookieDomain(domain);

      expect(result).toBe('.sub.sub.duckdns.org');
    });
  });
});
