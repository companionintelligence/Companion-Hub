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

describe('AccountService', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('createUser', () => {
    it('should create a new user with hashed password', async () => {
      const { AccountService } = await import('../services/account.js');
      
      mockDb.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users WHERE email')) {
          return { get: vi.fn().mockReturnValue(null) };
        }
        if (sql.includes('SELECT id FROM users WHERE username')) {
          return { get: vi.fn().mockReturnValue(null) };
        }
        if (sql.includes('INSERT INTO users')) {
          return { run: vi.fn().mockReturnValue({ lastInsertRowid: 1 }) };
        }
        if (sql.includes('SELECT * FROM users WHERE id')) {
          return { 
            get: vi.fn().mockReturnValue({
              id: 1,
              email: 'test@example.com',
              password_hash: 'hashed',
              username: 'testuser',
              display_name: 'Test User',
              created_at: new Date().toISOString(),
            }) 
          };
        }
        return { get: vi.fn(), run: vi.fn() };
      });

      const service = new AccountService(mockDb as any);
      const user = await service.createUser({
        email: 'test@example.com',
        password: 'password123',
        username: 'testuser',
        display_name: 'Test User',
      });

      expect(user).toBeDefined();
      expect(user.email).toBe('test@example.com');
      expect(user.username).toBe('testuser');
    });

    it('should throw error if email already exists', async () => {
      const { AccountService } = await import('../services/account.js');
      
      mockDb.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users WHERE email')) {
          return { get: vi.fn().mockReturnValue({ id: 1 }) };
        }
        return { get: vi.fn(), run: vi.fn() };
      });

      const service = new AccountService(mockDb as any);
      
      await expect(service.createUser({
        email: 'existing@example.com',
        password: 'password123',
      })).rejects.toThrow('Email already registered');
    });

    it('should throw error if username already exists', async () => {
      const { AccountService } = await import('../services/account.js');
      
      mockDb.prepare.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM users WHERE email')) {
          return { get: vi.fn().mockReturnValue(null) };
        }
        if (sql.includes('SELECT id FROM users WHERE username')) {
          return { get: vi.fn().mockReturnValue({ id: 2 }) };
        }
        return { get: vi.fn(), run: vi.fn() };
      });

      const service = new AccountService(mockDb as any);
      
      await expect(service.createUser({
        email: 'new@example.com',
        password: 'password123',
        username: 'existinguser',
      })).rejects.toThrow('Username already taken');
    });
  });

  describe('authenticateUser', () => {
    it('should return null for non-existent email', async () => {
      const { AccountService } = await import('../services/account.js');
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      });

      const service = new AccountService(mockDb as any);
      const result = await service.authenticateUser('notfound@example.com', 'password');

      expect(result).toBeNull();
    });

    it('should return null for incorrect password', async () => {
      const { AccountService } = await import('../services/account.js');
      
      // Create a user first to get a valid hash
      const service = new AccountService(mockDb as any);
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: 1,
          email: 'test@example.com',
          password_hash: 'invalidsalt:invalidhash',
        }),
      });

      const result = await service.authenticateUser('test@example.com', 'wrongpassword');

      expect(result).toBeNull();
    });
  });

  describe('getPublicProfile', () => {
    it('should remove sensitive fields from user profile', async () => {
      const { AccountService } = await import('../services/account.js');
      
      const service = new AccountService(mockDb as any);
      const fullUser = {
        id: 1,
        email: 'test@example.com',
        password_hash: 'secret_hash',
        username: 'testuser',
        display_name: 'Test User',
        avatar_url: null,
        email_verified: 1,
        stripe_customer_id: 'cus_123',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const publicProfile = service.getPublicProfile(fullUser);

      expect(publicProfile).not.toHaveProperty('password_hash');
      expect(publicProfile).not.toHaveProperty('stripe_customer_id');
      expect(publicProfile).toHaveProperty('email');
      expect(publicProfile).toHaveProperty('username');
    });
  });

  describe('entitlements', () => {
    it('should check if user has entitlement', async () => {
      const { AccountService } = await import('../services/account.js');
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue({ id: 1 }),
      });

      const service = new AccountService(mockDb as any);
      const hasAccess = await service.hasEntitlement(1, 'test-app');

      expect(hasAccess).toBe(true);
    });

    it('should return false for no entitlement', async () => {
      const { AccountService } = await import('../services/account.js');
      
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      });

      const service = new AccountService(mockDb as any);
      const hasAccess = await service.hasEntitlement(1, 'unowned-app');

      expect(hasAccess).toBe(false);
    });

    it('should grant entitlement to user', async () => {
      const { AccountService } = await import('../services/account.js');
      
      const runMock = vi.fn();
      mockDb.prepare.mockReturnValue({ run: runMock });

      const service = new AccountService(mockDb as any);
      await service.grantEntitlement({
        userId: 1,
        appUrn: 'new-app',
        entitlementType: 'purchase',
        paymentId: 123,
      });

      expect(runMock).toHaveBeenCalled();
    });
  });
});
