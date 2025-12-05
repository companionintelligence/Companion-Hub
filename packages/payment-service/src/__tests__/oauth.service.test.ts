import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const originalEnv = process.env;

// Mock better-sqlite3
const mockDb = {
  prepare: vi.fn(),
  exec: vi.fn(),
  pragma: vi.fn(),
};

vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn(() => mockDb),
  };
});

describe('OAuthService', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('registerClient', () => {
    it('should register a new OAuth client', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      mockDb.prepare.mockReturnValue({
        run: vi.fn(),
      });

      const service = new OAuthService(mockDb as any);
      const result = await service.registerClient({
        name: 'Test App',
        redirectUris: ['https://app.example.com/callback'],
        scopes: ['read', 'write'],
      });

      expect(result).toHaveProperty('clientId');
      expect(result).toHaveProperty('clientSecret');
      expect(result.clientId.length).toBeGreaterThan(0);
      expect(result.clientSecret.length).toBeGreaterThan(0);
    });
  });

  describe('validateClient', () => {
    it('should return false for non-existent client', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      });

      const service = new OAuthService(mockDb as any);
      const result = await service.validateClient('unknown', 'secret');

      expect(result).toBe(false);
    });

    it('should return false for inactive client', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: 'client1',
          is_active: 0,
          secret_hash: 'hash',
        }),
      });

      const service = new OAuthService(mockDb as any);
      const result = await service.validateClient('client1', 'secret');

      expect(result).toBe(false);
    });
  });

  describe('validateRedirectUri', () => {
    it('should return true for registered redirect URI', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: 'client1',
          redirect_uris: JSON.stringify(['https://app.example.com/callback']),
        }),
      });

      const service = new OAuthService(mockDb as any);
      const result = await service.validateRedirectUri('client1', 'https://app.example.com/callback');

      expect(result).toBe(true);
    });

    it('should return false for unregistered redirect URI', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: 'client1',
          redirect_uris: JSON.stringify(['https://app.example.com/callback']),
        }),
      });

      const service = new OAuthService(mockDb as any);
      const result = await service.validateRedirectUri('client1', 'https://evil.com/callback');

      expect(result).toBe(false);
    });
  });

  describe('PKCE', () => {
    it('should generate code verifier', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      const service = new OAuthService(mockDb as any);
      const verifier = service.generateCodeVerifier();

      expect(verifier.length).toBeGreaterThan(0);
    });

    it('should generate code challenge from verifier', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      const service = new OAuthService(mockDb as any);
      const verifier = service.generateCodeVerifier();
      const challenge = service.generateCodeChallenge(verifier);

      expect(challenge.length).toBeGreaterThan(0);
      expect(challenge).not.toBe(verifier); // S256 transforms the value
    });

    it('should generate same challenge for same verifier', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      const service = new OAuthService(mockDb as any);
      const verifier = 'test-verifier-123';
      const challenge1 = service.generateCodeChallenge(verifier);
      const challenge2 = service.generateCodeChallenge(verifier);

      expect(challenge1).toBe(challenge2);
    });
  });

  describe('createAuthorizationCode', () => {
    it('should create authorization code', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      mockDb.prepare.mockReturnValue({
        run: vi.fn(),
      });

      const service = new OAuthService(mockDb as any);
      const code = await service.createAuthorizationCode({
        clientId: 'client1',
        userId: 123,
        redirectUri: 'https://app.example.com/callback',
        scopes: ['read', 'write'],
      });

      expect(code.length).toBeGreaterThan(0);
    });

    it('should create authorization code with PKCE', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      mockDb.prepare.mockReturnValue({
        run: vi.fn(),
      });

      const service = new OAuthService(mockDb as any);
      const verifier = service.generateCodeVerifier();
      const challenge = service.generateCodeChallenge(verifier);

      const code = await service.createAuthorizationCode({
        clientId: 'client1',
        userId: 123,
        redirectUri: 'https://app.example.com/callback',
        scopes: ['read'],
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      });

      expect(code.length).toBeGreaterThan(0);
    });
  });

  describe('validateAccessToken', () => {
    it('should return null for non-existent token', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      });

      const service = new OAuthService(mockDb as any);
      const result = await service.validateAccessToken('invalid-token');

      expect(result).toBeNull();
    });

    it('should return null for expired token', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      const expiredDate = new Date(Date.now() - 1000).toISOString();
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          token: 'expired-token',
          client_id: 'client1',
          user_id: 123,
          scopes: '["read"]',
          expires_at: expiredDate,
        }),
        run: vi.fn(),
      });

      const service = new OAuthService(mockDb as any);
      const result = await service.validateAccessToken('expired-token');

      expect(result).toBeNull();
    });

    it('should return token info for valid token', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          token: 'valid-token',
          client_id: 'client1',
          user_id: 123,
          scopes: '["read","write"]',
          expires_at: futureDate,
        }),
      });

      const service = new OAuthService(mockDb as any);
      const result = await service.validateAccessToken('valid-token');

      expect(result).not.toBeNull();
      expect(result?.userId).toBe(123);
      expect(result?.clientId).toBe('client1');
      expect(result?.scopes).toEqual(['read', 'write']);
    });
  });

  describe('sessions', () => {
    it('should create a session', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      mockDb.prepare.mockReturnValue({
        run: vi.fn(),
      });

      const service = new OAuthService(mockDb as any);
      const sessionId = await service.createSession(123, '127.0.0.1', 'Mozilla/5.0');

      expect(sessionId.length).toBeGreaterThan(0);
    });

    it('should validate existing session', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          user_id: 123,
          expires_at: futureDate,
        }),
      });

      const service = new OAuthService(mockDb as any);
      const userId = await service.validateSession('valid-session');

      expect(userId).toBe(123);
    });

    it('should return null for expired session', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      const pastDate = new Date(Date.now() - 1000).toISOString();
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          user_id: 123,
          expires_at: pastDate,
        }),
        run: vi.fn(),
      });

      const service = new OAuthService(mockDb as any);
      const userId = await service.validateSession('expired-session');

      expect(userId).toBeNull();
    });
  });

  describe('cleanup', () => {
    it('should clean up expired tokens and codes', async () => {
      const { OAuthService } = await import('../services/oauth.js');
      
      mockDb.prepare.mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 5 }),
      });

      const service = new OAuthService(mockDb as any);
      const result = await service.cleanup();

      expect(result).toHaveProperty('codes');
      expect(result).toHaveProperty('accessTokens');
      expect(result).toHaveProperty('refreshTokens');
    });
  });
});
