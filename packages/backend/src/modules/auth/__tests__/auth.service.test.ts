import { CacheService } from '@/core/cache/cache.service';
import { PasswordService } from '@/core/password/password.service';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
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
import { SessionUserCache } from '@/core/cache/session-user.cache';
import type { LoginBody } from '../dto/auth.dto';
import axios from 'axios';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

describe('AuthService', () => {
  let authService: AuthService;
  let userRepository: MockProxy<UserRepository>;
  let federatedIdentityRepository: MockProxy<FederatedIdentityRepository>;
  let sessionManager: MockProxy<SessionManager>;
  let cacheService: MockProxy<CacheService>;
  let configurationService: MockProxy<ConfigurationService>;
  let passwordService: MockProxy<PasswordService>;

  beforeEach(async () => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.get).mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserRepository, useValue: mock<UserRepository>() },
        { provide: FederatedIdentityRepository, useValue: mock<FederatedIdentityRepository>() },
        { provide: PasswordService, useValue: mock<PasswordService>() },
        { provide: SessionManager, useValue: mock<SessionManager>() },
        { provide: CacheService, useValue: mock<CacheService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: EncryptionService, useValue: mock<EncryptionService>() },
        { provide: FilesystemService, useValue: mock<FilesystemService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: SessionUserCache, useValue: mock<SessionUserCache>() },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
    userRepository = moduleRef.get(UserRepository);
    federatedIdentityRepository = moduleRef.get(FederatedIdentityRepository);
    sessionManager = moduleRef.get(SessionManager);
    cacheService = moduleRef.get(CacheService);
    configurationService = moduleRef.get(ConfigurationService);
    passwordService = moduleRef.get(PasswordService);
  });

  it('should be defined', () => {
    expect(authService).toBeDefined();
  });

  describe('login', () => {
    it('should return sessionId after Companion Account sign-in', async () => {
      const loginBody: LoginBody = { username: 'test@example.com', password: 'Password1!' };
      const mockUser = { id: 1, password: 'hashedPassword', totpEnabled: false };

      configurationService.getConfig.mockReturnValue({ ciCloudUrl: 'https://hub.example.com' } as never);
      vi.mocked(axios.post).mockResolvedValue({
        status: 200,
        data: {},
      });
      userRepository.getUserByUsername.mockResolvedValue(mockUser as never);
      sessionManager.createSession.mockResolvedValue('session-id' as never);

      const result = await authService.login(loginBody);

      expect(result).toEqual({ sessionId: 'session-id' });
      expect(sessionManager.createSession).toHaveBeenCalledWith(1);
    });

    it('surfaces Portal 429 as a wait instead of bad credentials', async () => {
      const loginBody: LoginBody = { username: 'test@example.com', password: 'Password1!' };

      configurationService.getConfig.mockReturnValue({ ciCloudUrl: 'https://hub.example.com' } as never);
      vi.mocked(axios.post).mockResolvedValue({
        status: 429,
        data: {},
        headers: { 'retry-after': '12' },
      });

      await expect(authService.login(loginBody)).rejects.toMatchObject({
        message: 'AUTH_ERROR_RATE_LIMITED',
        status: 429,
      });
      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });

    it('should return totpSessionId if totp is enabled', async () => {
      const loginBody: LoginBody = { username: 'totp@example.com', password: 'Password1!' };
      const mockUser = { id: 2, password: 'hashedPassword', totpEnabled: 1 };

      configurationService.getConfig.mockReturnValue({ ciCloudUrl: 'https://hub.example.com' } as never);
      vi.mocked(axios.post).mockResolvedValue({
        status: 200,
        data: {},
      });
      userRepository.getUserByUsername.mockResolvedValue(mockUser as never);

      const result = await authService.login(loginBody);

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

  describe('requestPasswordReset', () => {
    it('applies per-email rate limiting and only forwards first 3 requests per hour', async () => {
      configurationService.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.example.com' } as any);

      const cacheEntries = new Map<string, string>();
      cacheService.get.mockImplementation((key: string) => cacheEntries.get(key));
      cacheService.set.mockImplementation((key: string, value: string) => {
        cacheEntries.set(key, value);
      });

      const axiosPost = vi.mocked(axios.post);
      axiosPost.mockResolvedValue({ status: 200, data: {} });

      await authService.requestPasswordReset({ email: 'user@example.com' });
      await authService.requestPasswordReset({ email: 'user@example.com' });
      await authService.requestPasswordReset({ email: 'user@example.com' });
      await authService.requestPasswordReset({ email: 'user@example.com' });

      expect(axiosPost).toHaveBeenCalledTimes(3);
    });
  });

  describe('verifyPasswordResetToken', () => {
    beforeEach(() => {
      configurationService.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.example.com' } as never);
    });

    it('returns valid=false when portal responds with valid:false', async () => {
      vi.mocked(axios.get).mockResolvedValue({
        status: 200,
        data: { valid: false },
      });

      await expect(authService.verifyPasswordResetToken('expired-token')).resolves.toEqual({ valid: false });
    });

    it('returns valid=false when portal omits valid on a 200 response', async () => {
      vi.mocked(axios.get).mockResolvedValue({
        status: 200,
        data: { email: 'user@example.com' },
      });

      await expect(authService.verifyPasswordResetToken('bad-token')).resolves.toEqual({ valid: false });
    });

    it('returns valid=true only when portal explicitly validates the token', async () => {
      vi.mocked(axios.get).mockResolvedValue({
        status: 200,
        data: { valid: true, email: 'user@example.com' },
      });

      await expect(authService.verifyPasswordResetToken('good-token')).resolves.toEqual({
        valid: true,
        email: 'user@example.com',
      });
    });
  });

  describe('completePasswordReset', () => {
    beforeEach(() => {
      configurationService.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.example.com' } as never);
    });

    it('rejects passwords that do not meet complexity requirements', async () => {
      await expect(authService.completePasswordReset({ token: 'token', newPassword: 'password' })).rejects.toMatchObject({
        message: 'AUTH_ERROR_INVALID_PASSWORD_COMPLEXITY',
      });
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  describe('bootstrapOperatorFromPortalEmail', () => {
    it('normalizes the Portal address before the insert so the row can be found again', async () => {
      // `getUserByUsername` lowercases its argument and compares it to the stored column, so a row
      // written with the raw mixed-case address is unreachable forever after: the password form
      // throws AUTH_ERROR_USER_NOT_FOUND, and Portal SSO is the operator's only remaining door.
      userRepository.getUserByUsername.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([] as never);
      passwordService.hash.mockResolvedValue('hashed' as never);
      userRepository.createUser.mockResolvedValue({ id: 3, username: 'owner@example.com' } as never);

      await authService.bootstrapOperatorFromPortalEmail('  Owner@Example.com  ');

      expect(userRepository.getUserByUsername).toHaveBeenCalledWith('owner@example.com');
      expect(userRepository.createUser).toHaveBeenCalledWith(expect.objectContaining({ username: 'owner@example.com', operator: true }));
    });

    it('refuses to claim an appliance that already has an operator', async () => {
      userRepository.getUserByUsername.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'owner@example.com' }] as never);

      await expect(authService.bootstrapOperatorFromPortalEmail('stranger@example.com')).rejects.toMatchObject({
        message: 'AUTH_ERROR_USER_NOT_FOUND',
      });
      expect(userRepository.createUser).not.toHaveBeenCalled();
    });
  });

  describe('ensureFederatedUser', () => {
    const issuer = 'https://portal.example.com';
    const subject = 'portal-subject-123';

    it('returns the bound user when a (iss, sub) link already exists, ignoring email', async () => {
      const boundUser = { id: 7, username: 'old@example.com' };
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue({ id: 1, userId: 7 } as never);
      userRepository.getUserById.mockResolvedValue(boundUser as never);

      const result = await authService.ensureFederatedUser({
        issuer,
        subject,
        email: 'changed@example.com',
        emailVerified: true,
      });

      expect(result).toEqual(boundUser);
      // Existing binding is authoritative — must not re-provision or create a new link.
      expect(federatedIdentityRepository.create).not.toHaveBeenCalled();
    });

    it('links a new verified identity to a matched local user and records the binding', async () => {
      const localUser = { id: 3, username: 'user@example.com', operator: true };
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getUserByUsername.mockResolvedValue(localUser as never);

      const result = await authService.ensureFederatedUser({
        issuer,
        subject,
        email: 'User@Example.com',
        emailVerified: true,
      });

      expect(result).toEqual(localUser);
      expect(federatedIdentityRepository.create).toHaveBeenCalledWith({
        userId: 3,
        issuer,
        subject,
        email: 'user@example.com',
        emailVerified: true,
      });
    });

    it('rejects a first login when the email claim is not verified', async () => {
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);

      await expect(authService.ensureFederatedUser({ issuer, subject, email: 'user@example.com', emailVerified: false })).rejects.toMatchObject({
        message: 'AUTH_ERROR_EMAIL_NOT_VERIFIED',
      });

      expect(federatedIdentityRepository.create).not.toHaveBeenCalled();
    });

    it('allows an unverified email only when explicitly migrating a legacy operator', async () => {
      const localUser = { id: 9, username: 'legacy@example.com', operator: true };
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getUserByUsername.mockResolvedValue(localUser as never);

      const result = await authService.ensureFederatedUser({
        issuer,
        subject,
        email: 'legacy@example.com',
        emailVerified: false,
        allowUnverifiedEmailForMigration: true,
      });

      expect(result).toEqual(localUser);
      expect(federatedIdentityRepository.create).toHaveBeenCalledWith({
        userId: 9,
        issuer,
        subject,
        email: 'legacy@example.com',
        emailVerified: false,
      });
    });

    it('returns the winner binding when concurrent first-logins race on create', async () => {
      const localUser = { id: 3, username: 'user@example.com', operator: true };
      const winnerUser = { id: 5, username: 'user@example.com' };
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValueOnce(undefined as never).mockResolvedValueOnce({ id: 2, userId: 5 } as never);
      userRepository.getUserByUsername.mockResolvedValue(localUser as never);
      federatedIdentityRepository.create.mockRejectedValue(
        new Error('duplicate key value violates unique constraint "federated_identity_issuer_subject_idx"'),
      );
      userRepository.getUserById.mockResolvedValue(winnerUser as never);

      const result = await authService.ensureFederatedUser({
        issuer,
        subject,
        email: 'user@example.com',
        emailVerified: true,
      });

      expect(result).toEqual(winnerUser);
      expect(federatedIdentityRepository.findByIssuerSubject).toHaveBeenCalledTimes(2);
    });

    it('rejects when issuer or subject is missing', async () => {
      await expect(authService.ensureFederatedUser({ issuer: '', subject, email: 'user@example.com', emailVerified: true })).rejects.toMatchObject({
        message: 'AUTH_ERROR_INVALID_CREDENTIALS',
      });

      expect(federatedIdentityRepository.findByIssuerSubject).not.toHaveBeenCalled();
    });
  });
});
