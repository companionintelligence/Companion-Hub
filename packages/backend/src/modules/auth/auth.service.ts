import crypto from 'node:crypto';
import path from 'node:path';
import { TranslatableError } from '@/common/error/translatable-error';
import { hashEmailForLog } from '@/common/helpers/log-privacy';
import { meetsPasswordComplexity } from '@/common/helpers/password-policy';
import { CacheService } from '@/core/cache/cache.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import {
  buildPortalAxiosConfig,
  readPortalInternalUrlOverride,
  resolveOutboundPortalBaseUrl,
  withPortalAxiosHeaders,
} from '@/common/helpers/portal-url';
import { PasswordService } from '@/core/password/password.service';
import axios from 'axios';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { UserRepository } from '@/modules/user/user.repository';
import { HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import psl from 'psl';
import validator from 'validator';
import type { LoginBody, RegisterBody } from './dto/auth.dto';
import { passwordResetVerifyResponseSchema } from './dto/auth.dto';
import { SessionManager } from './session.manager';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { TotpAuthenticator } from './utils/totp-authenticator';

@Injectable()
export class AuthService {
  private static readonly PASSWORD_RESET_RATE_LIMIT_WINDOW_SECS = 60 * 60;
  private static readonly PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS = 3;

  constructor(
    private userRepository: UserRepository,
    private federatedIdentityRepository: FederatedIdentityRepository,
    private sessionManager: SessionManager,
    private config: ConfigurationService,
    private encryption: EncryptionService,
    private cache: CacheService,
    private filesystem: FilesystemService,
    private passwordService: PasswordService,
    private logger: LoggerService,
    private sessionUserCache: SessionUserCache,
  ) {}

  public getCookieDomain(domain?: string) {
    if (!domain || !validator.isFQDN(domain)) {
      return undefined;
    }

    const parsed = psl.parse(domain);
    // biome-ignore lint/suspicious/noExplicitAny: PSL types are tricky
    if ((parsed as any).error) {
      return undefined;
    }

    // biome-ignore lint/suspicious/noExplicitAny: PSL types are tricky
    return `.${(parsed as any).input}`;
  }

  private getPasswordResetPortalBaseUrl() {
    const { ciCloudUrl } = this.config.getConfig();
    const publicBase = ciCloudUrl?.trim().replace(/\/$/, '');

    if (!publicBase) {
      throw new ServiceUnavailableException('CI_CLOUD_URL is not configured on this Hub.');
    }

    return resolveOutboundPortalBaseUrl(publicBase, readPortalInternalUrlOverride());
  }

  private getPublicPortalBaseUrl() {
    const { ciCloudUrl } = this.config.getConfig();
    const publicBase = ciCloudUrl?.trim().replace(/\/$/, '');

    if (!publicBase) {
      throw new ServiceUnavailableException('CI_CLOUD_URL is not configured on this Hub.');
    }

    return publicBase;
  }

  private getPortalBaseUrl() {
    return this.getPasswordResetPortalBaseUrl();
  }

  private portalAxiosConfig() {
    return buildPortalAxiosConfig(this.getPublicPortalBaseUrl(), readPortalInternalUrlOverride());
  }

  private async signInWithPortal(email: string, password: string) {
    const base = this.getPortalBaseUrl();
    const publicBase = this.getPublicPortalBaseUrl();
    const portalConfig = this.portalAxiosConfig();
    const response = await axios.post(
      `${base}/api/auth/sign-in/email`,
      { email, password },
      {
        ...withPortalAxiosHeaders(portalConfig, {
          'Content-Type': 'application/json',
          Origin: publicBase,
        }),
        validateStatus: () => true,
        timeout: 15_000,
      },
    );

    const body = (await Promise.resolve(response.data).catch(() => ({}))) as { code?: string };

    if (response.status < 200 || response.status >= 300) {
      if (body.code === 'EMAIL_NOT_VERIFIED') {
        throw new TranslatableError('AUTH_ERROR_EMAIL_NOT_VERIFIED', {}, HttpStatus.BAD_REQUEST);
      }

      throw new TranslatableError('AUTH_ERROR_INVALID_CREDENTIALS', {}, HttpStatus.BAD_REQUEST);
    }
  }

  private async signUpWithPortal(email: string, password: string, name: string) {
    const base = this.getPortalBaseUrl();
    const publicBase = this.getPublicPortalBaseUrl();
    const portalConfig = this.portalAxiosConfig();
    const response = await axios.post(
      `${base}/api/auth/sign-up/email`,
      { email, password, name },
      {
        ...withPortalAxiosHeaders(portalConfig, {
          'Content-Type': 'application/json',
          Origin: publicBase,
        }),
        validateStatus: () => true,
        timeout: 15_000,
      },
    );

    const body = (await Promise.resolve(response.data).catch(() => ({}))) as { code?: string; token?: string | null };

    if (response.status < 200 || response.status >= 300) {
      if (body.code === 'USER_ALREADY_EXISTS') {
        throw new TranslatableError('AUTH_ERROR_USER_ALREADY_EXISTS', {}, HttpStatus.BAD_REQUEST);
      }

      throw new TranslatableError('AUTH_ERROR_ERROR_CREATING_USER', {}, HttpStatus.BAD_REQUEST);
    }

    return body.token !== null && body.token !== undefined;
  }

  /** Create the first local operator from a Portal account when none exists yet. */
  public bootstrapOperatorFromPortalEmail(email: string) {
    return this.ensureLocalCompanionUser(email);
  }

  private async ensureLocalCompanionUser(email: string) {
    const existing = await this.userRepository.getUserByUsername(email);

    if (existing) {
      return existing;
    }

    const operators = await this.userRepository.getOperators();

    if (operators.length > 0) {
      throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND', {}, HttpStatus.BAD_REQUEST);
    }

    const hash = await this.passwordService.hash(crypto.randomUUID());
    const created = await this.userRepository.createUser({ username: email, password: hash, operator: true });

    if (!created) {
      throw new TranslatableError('AUTH_ERROR_ERROR_CREATING_USER', {}, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return created;
  }

  /**
   * Resolve the local Hub user for a verified external OIDC identity, keyed by
   * the stable (issuer, subject) pair rather than by email.
   *
   * Resolution order (see CI-Engineering architecture/identity/unified-identity-plan.md, Track B/B2):
   *   1. If a `federated_identity` row already exists for (iss, sub), it is
   *      authoritative — return the bound user even if their email has since
   *      changed. This closes the email-reuse account-takeover gap.
   *   2. Otherwise this is a first login for that subject. Require the IdP to
   *      assert `email_verified` (the one exception is a one-time migration
   *      link — `allowUnverifiedEmailForMigration` — used to adopt pre-existing
   *      email-provisioned operators). Match/create the local user by email and
   *      record the (iss, sub) → user binding so all future logins skip email.
   *
   * @throws TranslatableError when the email is unverified and no migration link is allowed.
   */
  public async ensureFederatedUser(params: {
    issuer: string;
    subject: string;
    email: string;
    emailVerified: boolean;
    /** Permit linking by email match without a verified claim, for one-time migration of legacy operators only. */
    allowUnverifiedEmailForMigration?: boolean;
  }) {
    const issuer = params.issuer.trim();
    const subject = params.subject.trim();

    if (!issuer || !subject) {
      throw new TranslatableError('AUTH_ERROR_INVALID_CREDENTIALS', {}, HttpStatus.BAD_REQUEST);
    }

    const existingLink = await this.federatedIdentityRepository.findByIssuerSubject(issuer, subject);

    if (existingLink) {
      const linkedUser = await this.userRepository.getUserById(existingLink.userId);

      if (!linkedUser) {
        // Binding points at a user that no longer exists — refuse rather than silently re-provision.
        throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND', {}, HttpStatus.BAD_REQUEST);
      }

      return linkedUser;
    }

    const email = params.email.trim().toLowerCase();

    if (!email || !validator.isEmail(email)) {
      throw new TranslatableError('AUTH_ERROR_INVALID_CREDENTIALS', {}, HttpStatus.BAD_REQUEST);
    }

    if (!params.emailVerified && !params.allowUnverifiedEmailForMigration) {
      throw new TranslatableError('AUTH_ERROR_EMAIL_NOT_VERIFIED', {}, HttpStatus.BAD_REQUEST);
    }

    // First login for this subject: match or provision the local user by email,
    // then bind (iss, sub) so subsequent logins are email-independent.
    const localUser = await this.ensureLocalCompanionUser(email);

    try {
      await this.federatedIdentityRepository.create({
        userId: localUser.id,
        issuer,
        subject,
        email,
        emailVerified: params.emailVerified,
      });
    } catch (err) {
      const isConstraintViolation =
        err instanceof Error && (err.message.includes('unique') || err.message.includes('duplicate') || err.message.includes('23505'));

      if (!isConstraintViolation) {
        throw err;
      }

      // Concurrent first-logins can race on the unique (issuer, subject) index.
      const racedLink = await this.federatedIdentityRepository.findByIssuerSubject(issuer, subject);

      if (!racedLink) {
        throw err;
      }

      const linkedUser = await this.userRepository.getUserById(racedLink.userId);

      if (!linkedUser) {
        throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND', {}, HttpStatus.BAD_REQUEST);
      }

      return linkedUser;
    }

    return localUser;
  }

  private getPasswordResetRateLimitKey(email: string) {
    return `auth:password-reset:rate:${email}`;
  }

  private consumePasswordResetRateLimit(email: string) {
    const key = this.getPasswordResetRateLimitKey(email);
    const now = Math.floor(Date.now() / 1000);
    const rawValue = this.cache.get(key);

    if (!rawValue) {
      this.cache.set(key, JSON.stringify({ count: 1, startedAt: now }), AuthService.PASSWORD_RESET_RATE_LIMIT_WINDOW_SECS);
      return true;
    }

    try {
      const parsed = JSON.parse(rawValue) as { count?: number; startedAt?: number };
      const count = Number(parsed.count ?? 0);
      const startedAt = Number(parsed.startedAt ?? now);

      if (startedAt + AuthService.PASSWORD_RESET_RATE_LIMIT_WINDOW_SECS <= now) {
        this.cache.set(key, JSON.stringify({ count: 1, startedAt: now }), AuthService.PASSWORD_RESET_RATE_LIMIT_WINDOW_SECS);
        return true;
      }

      if (count >= AuthService.PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS) {
        return false;
      }

      this.cache.set(key, JSON.stringify({ count: count + 1, startedAt }), AuthService.PASSWORD_RESET_RATE_LIMIT_WINDOW_SECS);
      return true;
    } catch {
      this.cache.set(key, JSON.stringify({ count: 1, startedAt: now }), AuthService.PASSWORD_RESET_RATE_LIMIT_WINDOW_SECS);
      return true;
    }
  }

  /**
   * Given a username and password, login the user and return the session ID.
   *
   * @param username - The username of the user to login.
   * @param password - The password of the user to login.
   * @returns The session ID.
   */
  public login = async (input: LoginBody) => {
    const { username, password } = input;
    const email = username.trim().toLowerCase();

    await this.signInWithPortal(email, password);

    const user = await this.ensureLocalCompanionUser(email);

    if (user.totpEnabled) {
      const totpSessionId = crypto.randomUUID();
      this.cache.set(totpSessionId, user.id.toString());
      return { totpSessionId };
    }

    const sessionId = await this.sessionManager.createSession(user.id);

    return {
      sessionId,
    };
  };

  /**
   * Verify TOTP code and return a JWT token
   *
   * @param {object} params - An object containing the TOTP session ID and the TOTP code
   * @param {string} params.totpSessionId - The TOTP session ID
   * @param {string} params.totpCode - The TOTP code
   */
  public verifyTotp = async (params: { totpSessionId: string; totpCode: string }) => {
    const { totpSessionId, totpCode } = params;
    const userId = this.cache.get(totpSessionId);

    if (!userId) {
      throw new TranslatableError('AUTH_ERROR_TOTP_SESSION_NOT_FOUND');
    }

    const user = await this.userRepository.getUserById(Number(userId));

    if (!user) {
      throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND');
    }

    if (!user.totpEnabled || !user.totpSecret || !user.salt) {
      throw new TranslatableError('AUTH_ERROR_TOTP_NOT_ENABLED');
    }

    const totpSecret = this.encryption.decrypt(user.totpSecret, user.salt);
    const isValid = TotpAuthenticator.check(totpCode, totpSecret);

    if (!isValid) {
      throw new TranslatableError('AUTH_ERROR_TOTP_INVALID_CODE');
    }

    const sessionId = await this.sessionManager.createSession(user.id);

    this.cache.del(totpSessionId);

    return {
      sessionId,
    };
  };

  /**
   * Creates a new user with the provided email and password and returns a session token
   *
   * @param {LoginBody} input - An object containing the email and password fields
   */
  public register = async (input: RegisterBody) => {
    const operators = await this.userRepository.getOperators();

    if (operators.length > 0) {
      throw new TranslatableError('AUTH_ERROR_ADMIN_ALREADY_EXISTS', {}, HttpStatus.FORBIDDEN);
    }

    const { password, username } = input;
    const email = username.trim().toLowerCase();

    if (!username || !password) {
      throw new TranslatableError('AUTH_ERROR_MISSING_EMAIL_OR_PASSWORD', {}, HttpStatus.BAD_REQUEST);
    }

    if (username.length < 3 || !validator.isEmail(email)) {
      throw new TranslatableError('AUTH_ERROR_INVALID_USERNAME', {}, HttpStatus.BAD_REQUEST);
    }

    const user = await this.userRepository.getUserByUsername(email);

    if (user) {
      throw new TranslatableError('AUTH_ERROR_USER_ALREADY_EXISTS', {}, HttpStatus.BAD_REQUEST);
    }

    if (!meetsPasswordComplexity(password)) {
      throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD_COMPLEXITY', {}, HttpStatus.BAD_REQUEST);
    }

    const signedInImmediately = await this.signUpWithPortal(email, password, email.split('@')[0] ?? 'User');

    if (!signedInImmediately) {
      return {
        requiresEmailVerification: true,
      };
    }

    const hash = await this.passwordService.hash(crypto.randomUUID());
    const newUser = await this.userRepository.createUser({ username: email, password: hash, operator: true });

    if (!newUser) {
      throw new TranslatableError('AUTH_ERROR_ERROR_CREATING_USER', {}, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const sessionId = await this.sessionManager.createSession(newUser.id);

    return {
      sessionId,
    };
  };

  /**
   * Logs out the currently logged in user.
   */
  public logout = async (sessionId: string) => {
    const userId = this.sessionManager.resolveSessionUserId(sessionId);
    await this.sessionManager.deleteSession(sessionId);
    if (userId) {
      this.sessionUserCache.invalidate(userId);
    }
  };

  /**
   * Rotate the current session to a new ID with a fresh TTL for long-lived desktop use.
   */
  public refreshSession = async (sessionId: string) => {
    const nextSessionId = await this.sessionManager.rotateSession(sessionId);
    if (!nextSessionId) {
      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN', undefined, HttpStatus.UNAUTHORIZED);
    }

    return nextSessionId;
  };

  /**
   * Change the username of the currently logged in user.
   */
  public changeUsername = async (params: { password: string; userId: number; newUsername: string }) => {
    if (this.config.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    const { newUsername, password, userId } = params;

    const user = await this.userRepository.getUserById(userId);

    if (!user) {
      throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND');
    }

    const valid = await this.passwordService.verify(password, user.password);

    if (!valid) {
      throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD');
    }

    const email = newUsername.trim().toLowerCase();

    if (!validator.isEmail(email)) {
      throw new TranslatableError('AUTH_ERROR_INVALID_USERNAME');
    }

    const existingUser = await this.userRepository.getUserByUsername(email);

    if (existingUser) {
      throw new TranslatableError('AUTH_ERROR_USER_ALREADY_EXISTS');
    }

    await this.userRepository.updateUser(user.id, { username: email });
    await this.sessionManager.destroyAllSessionsByUserId(user.id);
    this.sessionUserCache.invalidate(user.id);

    return true;
  };

  public changePassword = async (params: { currentPassword: string; newPassword: string; userId: number }) => {
    if (this.config.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    const { currentPassword, newPassword, userId } = params;

    const user = await this.userRepository.getUserById(userId);

    if (!user) {
      throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND');
    }

    const valid = await this.passwordService.verify(currentPassword, user.password);

    if (!valid) {
      throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD');
    }

    if (newPassword.length < 8) {
      throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD_LENGTH');
    }

    const hash = await this.passwordService.hash(newPassword);
    await this.userRepository.updateUser(user.id, { password: hash });
    await this.sessionManager.destroyAllSessionsByUserId(user.id);
    this.sessionUserCache.invalidate(user.id);

    return true;
  };

  /**
   * Given a userId returns the TOTP URI and the secret key
   *
   * @param {object} params - An object containing the userId and the user's password
   * @param {number} params.userId - The user's ID
   * @param {string} params.password - The user's password
   */
  public getTotpUri = async (params: { userId: number; password: string }) => {
    if (this.config.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    const { userId, password } = params;

    const user = await this.userRepository.getUserById(userId);

    if (!user) {
      throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND');
    }

    const isPasswordValid = await this.passwordService.verify(password, user.password);
    if (!isPasswordValid) {
      throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD');
    }

    if (user.totpEnabled) {
      throw new TranslatableError('AUTH_ERROR_TOTP_ALREADY_ENABLED');
    }

    let { salt } = user;
    const newTotpSecret = TotpAuthenticator.generateSecret();

    if (!salt) {
      salt = this.sessionManager.generateSalt();
    }

    const encryptedTotpSecret = this.encryption.encrypt(newTotpSecret, salt);

    await this.userRepository.updateUser(userId, { totpSecret: encryptedTotpSecret, salt });

    const uri = TotpAuthenticator.keyuri(user.username, 'CI Hub', newTotpSecret);

    return { uri, key: newTotpSecret };
  };

  public setupTotp = async (params: { userId: number; totpCode: string }) => {
    if (this.config.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    const { userId, totpCode } = params;
    const user = await this.userRepository.getUserById(userId);

    if (!user) {
      throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND');
    }

    if (user.totpEnabled || !user.totpSecret || !user.salt) {
      throw new TranslatableError('AUTH_ERROR_TOTP_ALREADY_ENABLED');
    }

    const totpSecret = this.encryption.decrypt(user.totpSecret, user.salt);
    const isValid = TotpAuthenticator.check(totpCode, totpSecret);

    if (!isValid) {
      throw new TranslatableError('AUTH_ERROR_TOTP_INVALID_CODE');
    }

    await this.userRepository.updateUser(userId, { totpEnabled: true });

    return true;
  };

  public disableTotp = async (params: { userId: number; password: string }) => {
    const { userId, password } = params;

    const user = await this.userRepository.getUserById(userId);

    if (!user) {
      throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND');
    }

    if (!user.totpEnabled) {
      throw new TranslatableError('AUTH_ERROR_TOTP_NOT_ENABLED');
    }

    const isPasswordValid = await this.passwordService.verify(password, user.password);
    if (!isPasswordValid) {
      throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD');
    }

    await this.userRepository.updateUser(userId, { totpEnabled: false, totpSecret: null });

    return true;
  };

  public requestPasswordReset = async (params: { email: string; ipAddress?: string; returnOrigin?: string; deviceId?: string }) => {
    const email = params.email.trim().toLowerCase();
    const rateLimitAllowed = this.consumePasswordResetRateLimit(email);

    this.logger.info('Password reset requested', {
      emailHash: hashEmailForLog(email),
      deviceId: params.deviceId,
      ipAddress: params.ipAddress,
      rateLimitAllowed,
    });

    if (!rateLimitAllowed) {
      this.logger.warn('Password reset rate limited', { emailHash: hashEmailForLog(email), ipAddress: params.ipAddress });
      return { success: true };
    }

    const base = this.getPasswordResetPortalBaseUrl();
    const portalConfig = this.portalAxiosConfig();

    try {
      const response = await axios.post(
        `${base}/api/auth/password-reset/request`,
        {
          email,
          returnOrigin: params.returnOrigin,
          deviceId: params.deviceId,
        },
        {
          ...withPortalAxiosHeaders(portalConfig, { 'Content-Type': 'application/json' }),
          validateStatus: () => true,
          timeout: 15_000,
        },
      );

      if (response.status < 200 || response.status >= 300) {
        this.logger.warn('Portal password reset request failed', {
          status: response.status,
          emailHash: hashEmailForLog(email),
          ipAddress: params.ipAddress,
        });
      }
    } catch (error) {
      this.logger.error('Portal password reset request failed', error);
    }

    return { success: true };
  };

  public verifyPasswordResetToken = async (token: string) => {
    const base = this.getPasswordResetPortalBaseUrl();

    try {
      const response = await axios.get(`${base}/api/auth/password-reset/verify/${encodeURIComponent(token)}`, {
        ...this.portalAxiosConfig(),
        validateStatus: () => true,
        timeout: 15_000,
      });

      if (response.status < 200 || response.status >= 300) {
        return { valid: false };
      }

      const data = response.data;
      const parsed = passwordResetVerifyResponseSchema.safeParse(data);
      if (!parsed.success || parsed.data.valid !== true) {
        return { valid: false };
      }

      return {
        valid: true,
        email: parsed.data.email,
      };
    } catch {
      return { valid: false };
    }
  };

  public completePasswordReset = async (params: { token: string; newPassword: string; ipAddress?: string }) => {
    if (params.newPassword.length < 8) {
      throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD_LENGTH', {}, HttpStatus.BAD_REQUEST);
    }

    if (!meetsPasswordComplexity(params.newPassword)) {
      throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD_COMPLEXITY', {}, HttpStatus.BAD_REQUEST);
    }

    const base = this.getPasswordResetPortalBaseUrl();
    const portalConfig = this.portalAxiosConfig();
    const response = await axios.post(
      `${base}/api/auth/password-reset/complete`,
      { token: params.token, newPassword: params.newPassword },
      {
        ...withPortalAxiosHeaders(portalConfig, { 'Content-Type': 'application/json' }),
        validateStatus: () => true,
        timeout: 15_000,
      },
    );

    if (response.status < 200 || response.status >= 300) {
      throw new TranslatableError('AUTH_ERROR_NO_CHANGE_PASSWORD_REQUEST', {}, HttpStatus.BAD_REQUEST);
    }

    this.logger.info('Password reset completed', { ipAddress: params.ipAddress });
    return { success: true };
  };

  /**
   * Change the password of the operator user
   *
   * @param {object} params - An object containing the new password
   * @param {string} params.newPassword - The new password
   */
  public changeOperatorPassword = async (params: { newPassword: string }) => {
    const isRequested = await this.checkPasswordChangeRequest();

    if (!isRequested) {
      throw new TranslatableError('AUTH_ERROR_NO_CHANGE_PASSWORD_REQUEST');
    }

    const { newPassword } = params;

    const user = await this.userRepository.getFirstOperator();

    if (!user) {
      throw new TranslatableError('AUTH_ERROR_OPERATOR_NOT_FOUND');
    }

    const hash = await this.passwordService.hash(newPassword);

    await this.userRepository.updateUser(user.id, { password: hash, totpEnabled: false, totpSecret: null });

    const { dataDir } = this.config.get('directories');
    await this.filesystem.removeFile(path.join(dataDir, 'state', 'password-change-request'));

    await this.sessionManager.destroyAllSessionsByUserId(user.id);

    return { email: user.username };
  };

  /*
   * Check if there is a pending password change request for the given email
   * Returns true if there is a file in the password change requests folder with the given email
   *
   * @returns {boolean} - A boolean indicating if there is a password change request or not
   */
  public checkPasswordChangeRequest = async () => {
    const REQUEST_TIMEOUT_SECS = 15 * 60; // 15 minutes

    const { dataDir } = this.config.get('directories');
    const resetPasswordFilePath = path.join(dataDir, 'state', 'password-change-request');

    try {
      const timestamp = await this.filesystem.readTextFile(resetPasswordFilePath);

      if (!timestamp) {
        return false;
      }

      const requestCreation = Number(timestamp);
      return requestCreation + REQUEST_TIMEOUT_SECS > Date.now() / 1000;
    } catch {
      return false;
    }
  };

  /*
   * If there is a pending password change request, remove it
   * Returns true if the file is removed successfully
   *
   * @returns {boolean} - A boolean indicating if the file is removed successfully or not
   * @throws {Error} - If the file cannot be removed
   */
  public cancelPasswordChangeRequest = async () => {
    const { dataDir } = this.config.get('directories');
    const changeRequestPath = path.join(dataDir, 'state', 'password-change-request');

    await this.filesystem.removeFile(changeRequestPath);

    return true;
  };
}
