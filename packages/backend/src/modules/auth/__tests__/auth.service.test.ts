import { CacheService } from '@/core/cache/cache.service';
import { PasswordService } from '@/core/password/password.service';
import { UserRepository } from '@/modules/user/user.repository';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  let configurationService: MockProxy<ConfigurationService>;

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
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
    userRepository = moduleRef.get(UserRepository);
    passwordService = moduleRef.get(PasswordService);
    sessionManager = moduleRef.get(SessionManager);
    cacheService = moduleRef.get(CacheService);
    configurationService = moduleRef.get(ConfigurationService);
  });

  it('should be defined', () => {
    expect(authService).toBeDefined();
  });

  describe('login', () => {
    it('should return sessionId after Companion Account sign-in', async () => {
      const loginBody: LoginBody = { username: 'test@example.com', password: 'Password1!' };
      const mockUser = { id: 1, password: 'hashedPassword', totpEnabled: false };

      configurationService.getConfig.mockReturnValue({ ciCloudUrl: 'https://hub.example.com' } as never);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({}),
        }),
      );
      userRepository.getUserByUsername.mockResolvedValue(mockUser as never);
      sessionManager.createSession.mockResolvedValue('session-id' as never);

      const result = await authService.login(loginBody);

      expect(result).toEqual({ sessionId: 'session-id' });
      expect(sessionManager.createSession).toHaveBeenCalledWith(1);
      vi.unstubAllGlobals();
    });

    it('should return totpSessionId if totp is enabled', async () => {
      const loginBody: LoginBody = { username: 'totp@example.com', password: 'Password1!' };
      const mockUser = { id: 2, password: 'hashedPassword', totpEnabled: 1 };

      configurationService.getConfig.mockReturnValue({ ciCloudUrl: 'https://hub.example.com' } as never);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({}),
        }),
      );
      userRepository.getUserByUsername.mockResolvedValue(mockUser as never);

      const result = await authService.login(loginBody);

      expect(result).toHaveProperty('totpSessionId');
      expect(cacheService.set).toHaveBeenCalled();
      expect(sessionManager.createSession).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
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

  describe('requestPasswordReset', () => {
    it('applies per-email rate limiting and only forwards first 3 requests per hour', async () => {
      configurationService.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.example.com' } as any);

      const cacheEntries = new Map<string, string>();
      cacheService.get.mockImplementation((key: string) => cacheEntries.get(key));
      cacheService.set.mockImplementation((key: string, value: string) => {
        cacheEntries.set(key, value);
      });

      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await authService.requestPasswordReset({ email: 'user@example.com' });
      await authService.requestPasswordReset({ email: 'user@example.com' });
      await authService.requestPasswordReset({ email: 'user@example.com' });
      await authService.requestPasswordReset({ email: 'user@example.com' });

      expect(fetchMock).toHaveBeenCalledTimes(3);

      vi.unstubAllGlobals();
    });
  });
});
