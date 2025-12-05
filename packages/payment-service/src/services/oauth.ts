import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type Database from 'better-sqlite3';

export interface OAuthClient {
  id: string;
  secret_hash: string;
  name: string;
  redirect_uris: string;
  scopes: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface AuthorizationCode {
  code: string;
  client_id: string;
  user_id: number;
  redirect_uri: string;
  scopes: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  expires_at: string;
  created_at: string;
}

export interface AccessToken {
  token: string;
  client_id: string;
  user_id: number;
  scopes: string;
  expires_at: string;
  created_at: string;
}

export interface RefreshToken {
  token: string;
  access_token: string;
  client_id: string;
  user_id: number;
  expires_at: string;
  revoked: number;
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

/**
 * OAuth 2.0 Service
 * Implements OAuth 2.0 authorization server for the payment service
 * Supports Authorization Code flow with PKCE for secure authentication
 */
export class OAuthService {
  private db: Database.Database;
  
  // Token lifetimes
  private readonly AUTH_CODE_LIFETIME = 10 * 60 * 1000; // 10 minutes
  private readonly ACCESS_TOKEN_LIFETIME = 60 * 60 * 1000; // 1 hour
  private readonly REFRESH_TOKEN_LIFETIME = 30 * 24 * 60 * 60 * 1000; // 30 days

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Generate a secure random token
   */
  private generateToken(length: number = 32): string {
    return randomBytes(length).toString('base64url');
  }

  /**
   * Hash a client secret
   */
  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  /**
   * Verify a client secret
   */
  private verifySecret(secret: string, hash: string): boolean {
    const computedHash = this.hashSecret(secret);
    try {
      return timingSafeEqual(
        Buffer.from(computedHash, 'hex'),
        Buffer.from(hash, 'hex')
      );
    } catch {
      return false;
    }
  }

  /**
   * Generate PKCE code verifier
   */
  generateCodeVerifier(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Generate PKCE code challenge from verifier
   */
  generateCodeChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
  }

  /**
   * Register a new OAuth client
   */
  async registerClient(params: {
    name: string;
    redirectUris: string[];
    scopes?: string[];
  }): Promise<{ clientId: string; clientSecret: string }> {
    const clientId = this.generateToken(16);
    const clientSecret = this.generateToken(32);
    const secretHash = this.hashSecret(clientSecret);

    this.db.prepare(`
      INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, scopes)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      clientId,
      secretHash,
      params.name,
      JSON.stringify(params.redirectUris),
      JSON.stringify(params.scopes || ['read', 'write'])
    );

    return { clientId, clientSecret };
  }

  /**
   * Get OAuth client by ID
   */
  async getClient(clientId: string): Promise<OAuthClient | null> {
    const client = this.db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(clientId) as OAuthClient | undefined;
    return client || null;
  }

  /**
   * Validate client credentials
   */
  async validateClient(clientId: string, clientSecret: string): Promise<boolean> {
    const client = await this.getClient(clientId);
    if (!client || !client.is_active) {
      return false;
    }
    return this.verifySecret(clientSecret, client.secret_hash);
  }

  /**
   * Validate redirect URI for a client
   */
  async validateRedirectUri(clientId: string, redirectUri: string): Promise<boolean> {
    const client = await this.getClient(clientId);
    if (!client) {
      return false;
    }

    const allowedUris = JSON.parse(client.redirect_uris) as string[];
    return allowedUris.includes(redirectUri);
  }

  /**
   * Create authorization code
   */
  async createAuthorizationCode(params: {
    clientId: string;
    userId: number;
    redirectUri: string;
    scopes: string[];
    codeChallenge?: string;
    codeChallengeMethod?: 'S256' | 'plain';
  }): Promise<string> {
    const code = this.generateToken(32);
    const expiresAt = new Date(Date.now() + this.AUTH_CODE_LIFETIME).toISOString();

    this.db.prepare(`
      INSERT INTO oauth_authorization_codes 
      (code, client_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code,
      params.clientId,
      params.userId,
      params.redirectUri,
      JSON.stringify(params.scopes),
      params.codeChallenge || null,
      params.codeChallengeMethod || null,
      expiresAt
    );

    return code;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeAuthorizationCode(params: {
    code: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<TokenResponse | null> {
    const authCode = this.db.prepare(
      'SELECT * FROM oauth_authorization_codes WHERE code = ?'
    ).get(params.code) as AuthorizationCode | undefined;

    if (!authCode) {
      return null;
    }

    // Delete the code immediately (single use)
    this.db.prepare('DELETE FROM oauth_authorization_codes WHERE code = ?').run(params.code);

    // Validate expiration
    if (new Date(authCode.expires_at) < new Date()) {
      return null;
    }

    // Validate client
    if (authCode.client_id !== params.clientId) {
      return null;
    }

    // Validate redirect URI
    if (authCode.redirect_uri !== params.redirectUri) {
      return null;
    }

    // Validate PKCE if code challenge was provided
    if (authCode.code_challenge) {
      if (!params.codeVerifier) {
        return null;
      }

      let computedChallenge: string;
      if (authCode.code_challenge_method === 'S256') {
        computedChallenge = this.generateCodeChallenge(params.codeVerifier);
      } else {
        computedChallenge = params.codeVerifier;
      }

      if (computedChallenge !== authCode.code_challenge) {
        return null;
      }
    } else if (params.clientSecret) {
      // If no PKCE, require client secret
      const validClient = await this.validateClient(params.clientId, params.clientSecret);
      if (!validClient) {
        return null;
      }
    }

    // Generate tokens
    return this.generateTokens(authCode.client_id, authCode.user_id, JSON.parse(authCode.scopes));
  }

  /**
   * Generate access and refresh tokens
   */
  private async generateTokens(clientId: string, userId: number, scopes: string[]): Promise<TokenResponse> {
    const accessToken = this.generateToken(32);
    const refreshToken = this.generateToken(32);
    const accessExpiresAt = new Date(Date.now() + this.ACCESS_TOKEN_LIFETIME).toISOString();
    const refreshExpiresAt = new Date(Date.now() + this.REFRESH_TOKEN_LIFETIME).toISOString();

    // Store access token
    this.db.prepare(`
      INSERT INTO oauth_access_tokens (token, client_id, user_id, scopes, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(accessToken, clientId, userId, JSON.stringify(scopes), accessExpiresAt);

    // Store refresh token
    this.db.prepare(`
      INSERT INTO oauth_refresh_tokens (token, access_token, client_id, user_id, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(refreshToken, accessToken, clientId, userId, refreshExpiresAt);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(this.ACCESS_TOKEN_LIFETIME / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(params: {
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
  }): Promise<TokenResponse | null> {
    const token = this.db.prepare(
      'SELECT * FROM oauth_refresh_tokens WHERE token = ?'
    ).get(params.refreshToken) as RefreshToken | undefined;

    if (!token) {
      return null;
    }

    // Validate not revoked
    if (token.revoked) {
      return null;
    }

    // Validate expiration
    if (new Date(token.expires_at) < new Date()) {
      return null;
    }

    // Validate client
    if (token.client_id !== params.clientId) {
      return null;
    }

    // If client secret provided, validate it
    if (params.clientSecret) {
      const validClient = await this.validateClient(params.clientId, params.clientSecret);
      if (!validClient) {
        return null;
      }
    }

    // Revoke old refresh token
    this.db.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token = ?').run(params.refreshToken);

    // Delete old access token
    this.db.prepare('DELETE FROM oauth_access_tokens WHERE token = ?').run(token.access_token);

    // Get scopes from old access token or use default
    const oldAccessToken = this.db.prepare(
      'SELECT scopes FROM oauth_access_tokens WHERE token = ?'
    ).get(token.access_token) as { scopes: string } | undefined;
    
    const scopes = oldAccessToken ? JSON.parse(oldAccessToken.scopes) : ['read'];

    // Generate new tokens
    return this.generateTokens(token.client_id, token.user_id, scopes);
  }

  /**
   * Validate access token and return user info
   */
  async validateAccessToken(token: string): Promise<{
    userId: number;
    clientId: string;
    scopes: string[];
  } | null> {
    const accessToken = this.db.prepare(
      'SELECT * FROM oauth_access_tokens WHERE token = ?'
    ).get(token) as AccessToken | undefined;

    if (!accessToken) {
      return null;
    }

    // Validate expiration
    if (new Date(accessToken.expires_at) < new Date()) {
      // Clean up expired token
      this.db.prepare('DELETE FROM oauth_access_tokens WHERE token = ?').run(token);
      return null;
    }

    return {
      userId: accessToken.user_id,
      clientId: accessToken.client_id,
      scopes: JSON.parse(accessToken.scopes),
    };
  }

  /**
   * Revoke all tokens for a user
   */
  async revokeUserTokens(userId: number): Promise<void> {
    this.db.prepare('DELETE FROM oauth_access_tokens WHERE user_id = ?').run(userId);
    this.db.prepare('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE user_id = ?').run(userId);
  }

  /**
   * Revoke specific access token
   */
  async revokeAccessToken(token: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM oauth_access_tokens WHERE token = ?').run(token);
    return result.changes > 0;
  }

  /**
   * Clean up expired tokens and codes
   */
  async cleanup(): Promise<{ codes: number; accessTokens: number; refreshTokens: number }> {
    const codes = this.db.prepare(
      "DELETE FROM oauth_authorization_codes WHERE expires_at < datetime('now')"
    ).run();

    const accessTokens = this.db.prepare(
      "DELETE FROM oauth_access_tokens WHERE expires_at < datetime('now')"
    ).run();

    const refreshTokens = this.db.prepare(
      "DELETE FROM oauth_refresh_tokens WHERE expires_at < datetime('now') OR revoked = 1"
    ).run();

    return {
      codes: codes.changes,
      accessTokens: accessTokens.changes,
      refreshTokens: refreshTokens.changes,
    };
  }

  /**
   * Create a session for web UI login
   */
  async createSession(userId: number, ipAddress?: string, userAgent?: string): Promise<string> {
    const sessionId = this.generateToken(32);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    this.db.prepare(`
      INSERT INTO sessions (id, user_id, ip_address, user_agent, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, userId, ipAddress || null, userAgent || null, expiresAt);

    return sessionId;
  }

  /**
   * Validate session and return user ID
   */
  async validateSession(sessionId: string): Promise<number | null> {
    const session = this.db.prepare(
      'SELECT user_id, expires_at FROM sessions WHERE id = ?'
    ).get(sessionId) as { user_id: number; expires_at: string } | undefined;

    if (!session) {
      return null;
    }

    if (new Date(session.expires_at) < new Date()) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      return null;
    }

    return session.user_id;
  }

  /**
   * Delete session (logout)
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return result.changes > 0;
  }

  /**
   * Delete all sessions for a user
   */
  async deleteUserSessions(userId: number): Promise<number> {
    const result = this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return result.changes;
  }
}
