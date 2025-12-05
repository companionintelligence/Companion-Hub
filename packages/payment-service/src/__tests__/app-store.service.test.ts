import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock environment variables
const originalEnv = process.env;

describe('AppStoreService', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('isConfigured', () => {
    it('should return false when GitHub token is not set', async () => {
      delete process.env.GITHUB_APP_STORE_TOKEN;
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      expect(service.isConfigured()).toBe(false);
    });

    it('should return true when GitHub token is set', async () => {
      process.env.GITHUB_APP_STORE_TOKEN = 'ghp_test_token';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('generatePaymentKey', () => {
    it('should generate a valid payment key', async () => {
      process.env.PAYMENT_KEY_SECRET = 'test-secret-key-32-chars-minimum!';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      const key = service.generatePaymentKey('test-app', 123);
      
      expect(key).toBeDefined();
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });

    it('should generate different keys for different apps', async () => {
      process.env.PAYMENT_KEY_SECRET = 'test-secret-key-32-chars-minimum!';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      const key1 = service.generatePaymentKey('app1', 123);
      const key2 = service.generatePaymentKey('app2', 123);
      
      expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different users', async () => {
      process.env.PAYMENT_KEY_SECRET = 'test-secret-key-32-chars-minimum!';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      const key1 = service.generatePaymentKey('test-app', 123);
      const key2 = service.generatePaymentKey('test-app', 456);
      
      expect(key1).not.toBe(key2);
    });

    it('should throw error when PAYMENT_KEY_SECRET is not set', async () => {
      delete process.env.PAYMENT_KEY_SECRET;
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      expect(() => service.generatePaymentKey('test-app', 123)).toThrow('PAYMENT_KEY_SECRET is not configured');
    });
  });

  describe('verifyPaymentKey', () => {
    it('should verify a valid payment key', async () => {
      process.env.PAYMENT_KEY_SECRET = 'test-secret-key-32-chars-minimum!';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      const key = service.generatePaymentKey('test-app', 123);
      const result = service.verifyPaymentKey(key);
      
      expect(result.valid).toBe(true);
      expect(result.appUrn).toBe('test-app');
      expect(result.userId).toBe(123);
    });

    it('should reject a malformed payment key', async () => {
      process.env.PAYMENT_KEY_SECRET = 'test-secret-key-32-chars-minimum!';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      const result = service.verifyPaymentKey('invalid-key');
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Malformed payment key');
    });

    it('should reject a payment key with wrong signature', async () => {
      process.env.PAYMENT_KEY_SECRET = 'secret1-must-be-long-enough-32ch!';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service1 = new AppStoreService();
      const key = service1.generatePaymentKey('test-app', 123);
      
      // Change secret and try to verify
      vi.resetModules();
      process.env.PAYMENT_KEY_SECRET = 'secret2-must-be-long-enough-32ch!';
      
      const { AppStoreService: AppStoreService2 } = await import('../services/app-store.js');
      const service2 = new AppStoreService2();
      const result = service2.verifyPaymentKey(key);
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid payment key signature');
    });

    it('should return error when PAYMENT_KEY_SECRET is not set during verification', async () => {
      delete process.env.PAYMENT_KEY_SECRET;
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      // Create a fake key (base64url encoded JSON)
      const fakeKey = Buffer.from(JSON.stringify({
        appUrn: 'test',
        userId: 1,
        timestamp: Date.now(),
        expiresAt: Date.now() + 1000,
        nonce: 'abc',
        signature: 'fake',
      })).toString('base64url');
      
      const result = service.verifyPaymentKey(fakeKey);
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Payment key verification not configured');
    });
  });

  describe('checkAppAccess', () => {
    it('should grant access to free apps without payment', async () => {
      process.env.GITHUB_APP_STORE_TOKEN = 'test-token';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      // Mock the getAppConfig method
      vi.spyOn(service, 'getAppConfig').mockResolvedValue({
        id: 'test-app',
        name: 'Test App',
        urn: 'test-app',
        pricing: { type: 'free' },
      });
      
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null),
        }),
      };
      
      const result = await service.checkAppAccess('test-app', 123, mockDb);
      
      expect(result.hasAccess).toBe(true);
      expect(result.paymentRequired).toBeUndefined();
    });

    it('should require payment for paid apps without completed payment', async () => {
      process.env.GITHUB_APP_STORE_TOKEN = 'test-token';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      vi.spyOn(service, 'getAppConfig').mockResolvedValue({
        id: 'paid-app',
        name: 'Paid App',
        urn: 'paid-app',
        pricing: { 
          type: 'one_time', 
          price: 9.99, 
          currency: 'USD',
          payment_methods: ['stripe'],
        },
      });
      
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null),
        }),
      };
      
      const result = await service.checkAppAccess('paid-app', 123, mockDb);
      
      expect(result.hasAccess).toBe(false);
      expect(result.paymentRequired).toBe(true);
      expect(result.pricingInfo?.price).toBe(9.99);
    });

    it('should grant access when payment is completed', async () => {
      process.env.GITHUB_APP_STORE_TOKEN = 'test-token';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      vi.spyOn(service, 'getAppConfig').mockResolvedValue({
        id: 'paid-app',
        name: 'Paid App',
        urn: 'paid-app',
        pricing: { type: 'one_time', price: 9.99 },
      });
      
      const mockPayment = { id: 1, status: 'completed', user_id: 123 };
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(mockPayment),
        }),
      };
      
      const result = await service.checkAppAccess('paid-app', 123, mockDb);
      
      expect(result.hasAccess).toBe(true);
    });

    it('should return not found for non-existent apps', async () => {
      process.env.GITHUB_APP_STORE_TOKEN = 'test-token';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      vi.spyOn(service, 'getAppConfig').mockResolvedValue(null);
      
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null),
        }),
      };
      
      const result = await service.checkAppAccess('nonexistent', 123, mockDb);
      
      expect(result.hasAccess).toBe(false);
      expect(result.reason).toBe('App not found');
    });
  });

  describe('subscription access', () => {
    it('should grant access for active subscription', async () => {
      process.env.GITHUB_APP_STORE_TOKEN = 'test-token';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      vi.spyOn(service, 'getAppConfig').mockResolvedValue({
        id: 'sub-app',
        name: 'Subscription App',
        urn: 'sub-app',
        pricing: { 
          type: 'subscription', 
          price: 9.99,
          interval: 'monthly',
        },
      });
      
      // First call returns no one-time payment
      // We need to simulate the subscription check
      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const mockSubscription = { 
        id: 1, 
        status: 'active', 
        current_period_end: futureDate,
      };
      
      let callCount = 0;
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return null; // No one-time payment
            return mockSubscription; // Active subscription
          }),
        }),
      };
      
      const result = await service.checkAppAccess('sub-app', 123, mockDb);
      
      expect(result.hasAccess).toBe(true);
    });

    it('should deny access for expired subscription', async () => {
      process.env.GITHUB_APP_STORE_TOKEN = 'test-token';
      
      const { AppStoreService } = await import('../services/app-store.js');
      const service = new AppStoreService();
      
      vi.spyOn(service, 'getAppConfig').mockResolvedValue({
        id: 'sub-app',
        name: 'Subscription App',
        urn: 'sub-app',
        pricing: { 
          type: 'subscription', 
          price: 9.99,
          interval: 'monthly',
        },
      });
      
      // Expired subscription
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const mockSubscription = { 
        id: 1, 
        status: 'active', 
        current_period_end: pastDate,
      };
      
      let callCount = 0;
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return null;
            return mockSubscription;
          }),
        }),
      };
      
      const result = await service.checkAppAccess('sub-app', 123, mockDb);
      
      expect(result.hasAccess).toBe(false);
      expect(result.paymentRequired).toBe(true);
    });
  });
});
