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
import { PortalClientService } from '@/core/portal/portal-client.service';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
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
  let portal: MockProxy<PortalClientService>;
  let deviceRegistration: MockProxy<DeviceRegistrationRepository>;

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
        { provide: PortalClientService, useValue: mock<PortalClientService>() },
        { provide: DeviceRegistrationRepository, useValue: mock<DeviceRegistrationRepository>() },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
    userRepository = moduleRef.get(UserRepository);
    federatedIdentityRepository = moduleRef.get(FederatedIdentityRepository);
    sessionManager = moduleRef.get(SessionManager);
    cacheService = moduleRef.get(CacheService);
    configurationService = moduleRef.get(ConfigurationService);
    passwordService = moduleRef.get(PasswordService);
    portal = moduleRef.get(PortalClientService);
    deviceRegistration = moduleRef.get(DeviceRegistrationRepository);
    userRepository.getOperators.mockResolvedValue([]);
    federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
    deviceRegistration.getFirstDeviceRegistration.mockResolvedValue(null as never);
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

  describe('admitHubPerson', () => {
    const issuer = 'https://hub.example.com';

    it('creates a second operator when the Portal subject is a member of this Hub org', async () => {
      const created = { id: 2, username: 'hello@lifescope.io', operator: true, hasCompletedOnboarding: true };
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'chamberlain@example.com', hasCompletedOnboarding: true }] as never);
      userRepository.getUserByUsername.mockResolvedValue(undefined as never);
      userRepository.createUser.mockResolvedValue(created as never);
      passwordService.hash.mockResolvedValue('hash');
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      portal.whoisApps.mockResolvedValue({
        status: 200,
        body: { organizations: [{ organizationId: 'org-1', apps: [] }] },
      });

      const result = await authService.admitHubPerson({
        issuer,
        subject: 'portal-hello',
        email: 'hello@lifescope.io',
        emailVerified: true,
      });

      expect(result).toEqual(created);
      expect(userRepository.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'hello@lifescope.io', operator: true, hasCompletedOnboarding: true }),
      );
      expect(federatedIdentityRepository.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 2, issuer, subject: 'portal-hello' }));
    });

    it('does not skip the device wizard when the appliance has never been onboarded', async () => {
      const created = { id: 2, username: 'hello@lifescope.io', operator: true, hasCompletedOnboarding: false };
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'chamberlain@example.com', hasCompletedOnboarding: false }] as never);
      userRepository.getUserByUsername.mockResolvedValue(undefined as never);
      userRepository.createUser.mockResolvedValue(created as never);
      passwordService.hash.mockResolvedValue('hash');
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      portal.whoisApps.mockResolvedValue({
        status: 200,
        body: { organizations: [{ organizationId: 'org-1', apps: [] }] },
      });

      await authService.admitHubPerson({
        issuer,
        subject: 'portal-hello',
        email: 'hello@lifescope.io',
        emailVerified: true,
      });

      expect(userRepository.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'hello@lifescope.io', hasCompletedOnboarding: false }),
      );
    });

    it('refuses a Portal person who is not in this Hub org', async () => {
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'chamberlain@example.com' }] as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      portal.whoisApps.mockResolvedValue({
        status: 200,
        body: { organizations: [{ organizationId: 'other-org', apps: [] }] },
      });

      await expect(
        authService.admitHubPerson({
          issuer,
          subject: 'portal-stranger',
          email: 'stranger@example.com',
          emailVerified: true,
        }),
      ).rejects.toMatchObject({ message: 'AUTH_ERROR_NOT_ORG_MEMBER' });

      expect(userRepository.createUser).not.toHaveBeenCalled();
    });

    it('answers 503, not "not a member", when Portal cannot be reached to check', async () => {
      // Both outcomes deny, but only one is the person's problem. Telling an operator "you are not a
      // member of this organization" during a Portal outage sends them to chase an invite that was
      // never missing; 503 tells them (and the retry logic) to come back.
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'chamberlain@example.com' }] as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      portal.whoisApps.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(
        authService.admitHubPerson({
          issuer,
          subject: 'portal-person',
          email: 'person@example.com',
          emailVerified: true,
        }),
      ).rejects.toMatchObject({ message: 'AUTH_ERROR_ORG_CHECK_UNAVAILABLE', status: 503 });

      expect(userRepository.createUser).not.toHaveBeenCalled();
    });

    it('refuses, rather than deferring forever, when this Hub is paired to no organization', async () => {
      // An appliance with no device registration is not a Portal wobble: it is a settled local
      // fact. Answering `unknown` told the operator to "try again in a moment" for a condition
      // that never clears, and — because `unknown` is never remembered — made every forwarded app
      // request re-read the row and write a fresh warn line.
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'chamberlain@example.com' }] as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue(null as never);

      await expect(
        authService.admitHubPerson({
          issuer,
          subject: 'portal-person',
          email: 'person@example.com',
          emailVerified: true,
        }),
      ).rejects.toMatchObject({ message: 'AUTH_ERROR_NOT_ORG_MEMBER' });

      expect(portal.whoisApps).not.toHaveBeenCalled();
    });

    it('answers 503 when the device-registration read itself fails', async () => {
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'chamberlain@example.com' }] as never);
      deviceRegistration.getFirstDeviceRegistration.mockRejectedValue(new Error('connection terminated'));

      await expect(
        authService.admitHubPerson({
          issuer,
          subject: 'portal-person',
          email: 'person@example.com',
          emailVerified: true,
        }),
      ).rejects.toMatchObject({ message: 'AUTH_ERROR_ORG_CHECK_UNAVAILABLE', status: 503 });
    });

    it('answers 503 when Portal answers 5xx rather than calling the person a stranger', async () => {
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'chamberlain@example.com' }] as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      portal.whoisApps.mockResolvedValue({ status: 503, body: null });

      await expect(
        authService.admitHubPerson({
          issuer,
          subject: 'portal-person',
          email: 'person@example.com',
          emailVerified: true,
        }),
      ).rejects.toMatchObject({ message: 'AUTH_ERROR_ORG_CHECK_UNAVAILABLE', status: 503 });
    });

    it("names this Hub's organization, so Portal can settle a device paired to two at once", async () => {
      // A tie on the newest pairing answers 409 ORGANIZATION_REQUIRED unless the request names one
      // of the tied organizations; without it every sign-in on such a Hub was "try again".
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'chamberlain@example.com' }] as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      portal.whoisApps.mockResolvedValue({ status: 200, body: { organizations: [{ organizationId: 'org-1', apps: [] }] } });

      await expect(authService.resolvePairedOrgMembership('portal-person')).resolves.toBe('member');
      expect(portal.whoisApps).toHaveBeenCalledWith(expect.objectContaining({ subject: 'portal-person', organizationId: 'org-1' }));
    });

    it('refuses a person Portal answers 403 for as not a member, rather than telling them to try again', async () => {
      // Device WhoIs answers 403 `GRANT_DENIED` for a subject in none of this device's organizations (or not
      // in the one named). That is an answer, not an outage.
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'chamberlain@example.com' }] as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      portal.whoisApps.mockResolvedValue({
        status: 403,
        body: { error: 'Not a member of an organization this device is registered to', code: 'GRANT_DENIED' } as never,
        code: 'GRANT_DENIED',
      });

      await expect(authService.resolvePairedOrgMembership('portal-stranger')).resolves.toBe('not-member');
      await expect(
        authService.admitHubPerson({
          issuer,
          subject: 'portal-stranger',
          email: 'stranger@example.com',
          emailVerified: true,
        }),
      ).rejects.toMatchObject({ message: 'AUTH_ERROR_NOT_ORG_MEMBER' });
      expect(userRepository.createUser).not.toHaveBeenCalled();
    });

    it('answers 503, not "not a member", for a 403 that did not come from Portal', async () => {
      // A firewall or proxy in front of Portal answers with a page of its own: no body, no `GRANT_DENIED`. That
      // says nothing about membership, and `not-member` would be remembered for the forward-auth Bearer TTL.
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'chamberlain@example.com' }] as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      portal.whoisApps.mockResolvedValue({ status: 403, body: null });

      await expect(authService.resolvePairedOrgMembership('portal-person')).resolves.toBe('unknown');
      await expect(
        authService.admitHubPerson({
          issuer,
          subject: 'portal-person',
          email: 'person@example.com',
          emailVerified: true,
        }),
      ).rejects.toMatchObject({ message: 'AUTH_ERROR_ORG_CHECK_UNAVAILABLE', status: 503 });
    });

    it('still answers 503 on a tie Portal could not settle (409)', async () => {
      federatedIdentityRepository.findByIssuerSubject.mockResolvedValue(undefined as never);
      userRepository.getOperators.mockResolvedValue([{ id: 1, username: 'chamberlain@example.com' }] as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      // The body Portal really sends is an object, so it is the status, not a missing body, that keeps this `unknown`.
      portal.whoisApps.mockResolvedValue({
        status: 409,
        body: { error: 'This device is registered to more than one organization; name the one you mean.', code: 'ORGANIZATION_REQUIRED' } as never,
        code: 'ORGANIZATION_REQUIRED',
      });

      await expect(authService.resolvePairedOrgMembership('portal-person')).resolves.toBe('unknown');
      await expect(
        authService.admitHubPerson({
          issuer,
          subject: 'portal-person',
          email: 'person@example.com',
          emailVerified: true,
        }),
      ).rejects.toMatchObject({ message: 'AUTH_ERROR_ORG_CHECK_UNAVAILABLE', status: 503 });
      expect(userRepository.createUser).not.toHaveBeenCalled();
    });

    it('names the configured organization, the one grant and role reads name, on a Hub holding more than one', async () => {
      // The first row alone is an unordered pick between two registrations, and Portal honours whichever tied
      // organization is named: sign-in would answer for an organization this Hub's grants do not.
      configurationService.get.mockImplementation(((key: string) => (key === 'ciHubOrganizationId' ? 'org-2' : undefined)) as never);
      deviceRegistration.getDeviceRegistrationById.mockResolvedValue({ id: 'org-2' } as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      portal.whoisApps.mockResolvedValue({ status: 200, body: { organizations: [{ organizationId: 'org-2', apps: [] }] } });

      await expect(authService.resolvePairedOrgMembership('portal-person')).resolves.toBe('member');
      expect(deviceRegistration.getDeviceRegistrationById).toHaveBeenCalledWith('org-2');
      expect(portal.whoisApps).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-2' }));
    });

    it('names the first registration when the configured organization has no row', async () => {
      configurationService.get.mockImplementation(((key: string) => (key === 'ciHubOrganizationId' ? 'org-gone' : undefined)) as never);
      deviceRegistration.getDeviceRegistrationById.mockResolvedValue(null as never);
      deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as never);
      portal.whoisApps.mockResolvedValue({ status: 200, body: { organizations: [{ organizationId: 'org-1', apps: [] }] } });

      await expect(authService.resolvePairedOrgMembership('portal-person')).resolves.toBe('member');
      expect(portal.whoisApps).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
    });
  });
  describe('register', () => {
    const issuer = 'https://hub.example.com';

    beforeEach(() => {
      configurationService.getConfig.mockReturnValue({ ciCloudUrl: issuer } as never);
      userRepository.getUserByUsername.mockResolvedValue(undefined as never);
      passwordService.hash.mockResolvedValue('hashed' as never);
      sessionManager.createSession.mockResolvedValue('session-id' as never);
    });

    it('binds the Portal subject when Portal signs the new account in', async () => {
      /*
       * ⚠ THE OPERATOR USED TO BE CREATED WITH NO `federated_identity` ROW.
       * `MarketplaceWhoIsService.portalSubject` reads that table, so with no row
       * there is no subject to ask WhoIs about and the grant gate answers from a
       * fixed fallback list instead of this person's real Portal grants.
       *
       * The subject was in the sign-up response the whole time — the response
       * type simply did not name `user`.
       */
      vi.mocked(axios.post).mockResolvedValue({
        status: 200,
        data: { token: 'portal-session', user: { id: 'portal-subject-1', email: 'owner@example.com' } },
      });
      userRepository.createUser.mockResolvedValue({ id: 9, username: 'owner@example.com' } as never);

      const result = await authService.register({ username: 'owner@example.com', password: 'Password1!' } as never);

      expect(result).toEqual({ sessionId: 'session-id' });
      expect(federatedIdentityRepository.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 9, issuer, subject: 'portal-subject-1' }));
      expect(sessionManager.createSession).toHaveBeenCalledWith(9);
    });

    it('creates no local operator when Portal requires email verification', async () => {
      // Today's Portal has `requireEmailVerification` on, so sign-up returns no
      // session token. Nothing is provisioned here; the operator is linked on
      // their first login instead.
      vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { token: null } });

      await expect(authService.register({ username: 'owner@example.com', password: 'Password1!' } as never)).resolves.toEqual({
        requiresEmailVerification: true,
      });
      expect(userRepository.createUser).not.toHaveBeenCalled();
      expect(federatedIdentityRepository.create).not.toHaveBeenCalled();
    });

    it('still provisions the operator when Portal signs in but names no subject', async () => {
      // Degrades to the old unlinked behaviour rather than refusing to register.
      vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { token: 'portal-session' } });
      userRepository.createUser.mockResolvedValue({ id: 11, username: 'owner@example.com' } as never);

      await expect(authService.register({ username: 'owner@example.com', password: 'Password1!' } as never)).resolves.toEqual({
        sessionId: 'session-id',
      });
      expect(federatedIdentityRepository.create).not.toHaveBeenCalled();
      expect(sessionManager.createSession).toHaveBeenCalledWith(11);
    });
  });
});
