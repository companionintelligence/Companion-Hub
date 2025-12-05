import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const originalEnv = process.env;

describe('X402Service', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('isEnabled', () => {
    it('should return false when X402_ENABLED is not set', async () => {
      delete process.env.X402_ENABLED;
      delete process.env.X402_PAYMENT_ADDRESS;
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      expect(service.isEnabled()).toBe(false);
    });

    it('should return false when X402_ENABLED is false', async () => {
      process.env.X402_ENABLED = 'false';
      process.env.X402_PAYMENT_ADDRESS = '0x123';
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      expect(service.isEnabled()).toBe(false);
    });

    it('should return false when payment address is not set', async () => {
      process.env.X402_ENABLED = 'true';
      delete process.env.X402_PAYMENT_ADDRESS;
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      expect(service.isEnabled()).toBe(false);
    });

    it('should return true when both enabled and address are set', async () => {
      process.env.X402_ENABLED = 'true';
      process.env.X402_PAYMENT_ADDRESS = '0x1234567890abcdef';
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('verifyPayment', () => {
    it('should return false when X402 is not enabled', async () => {
      process.env.X402_ENABLED = 'false';
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      const result = await service.verifyPayment('0xabc123');
      
      expect(result).toBe(false);
    });

    it('should return false for empty transaction hash', async () => {
      process.env.X402_ENABLED = 'true';
      process.env.X402_PAYMENT_ADDRESS = '0x123';
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      const result = await service.verifyPayment('');
      
      expect(result).toBe(false);
    });

    it('should return false for short transaction hash', async () => {
      process.env.X402_ENABLED = 'true';
      process.env.X402_PAYMENT_ADDRESS = '0x123';
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      const result = await service.verifyPayment('abc');
      
      expect(result).toBe(false);
    });

    it('should return false (throw internally) for valid format hash - security placeholder', async () => {
      process.env.X402_ENABLED = 'true';
      process.env.X402_PAYMENT_ADDRESS = '0x123';
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      // Should return false because actual verification throws an error
      // This is the security placeholder behavior
      const result = await service.verifyPayment('0x1234567890abcdef1234567890abcdef');
      
      expect(result).toBe(false);
    });
  });

  describe('getSupportedCurrencies', () => {
    it('should return list of supported cryptocurrencies', async () => {
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      const currencies = service.getSupportedCurrencies();
      
      expect(Array.isArray(currencies)).toBe(true);
      expect(currencies.length).toBeGreaterThan(0);
      
      const symbols = currencies.map(c => c.symbol);
      expect(symbols).toContain('BTC');
      expect(symbols).toContain('ETH');
      expect(symbols).toContain('USDC');
      expect(symbols).toContain('USDT');
    });

    it('should return currencies with correct structure', async () => {
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      const currencies = service.getSupportedCurrencies();
      
      currencies.forEach(currency => {
        expect(currency).toHaveProperty('symbol');
        expect(currency).toHaveProperty('name');
        expect(currency).toHaveProperty('enabled');
        expect(typeof currency.symbol).toBe('string');
        expect(typeof currency.name).toBe('string');
        expect(typeof currency.enabled).toBe('boolean');
      });
    });
  });

  describe('createPaymentRequest', () => {
    it('should throw error when X402 is not enabled', async () => {
      process.env.X402_ENABLED = 'false';
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      await expect(service.createPaymentRequest({
        amount: 10,
        currency: 'USDC',
        appUrn: 'test-app',
        userId: 123,
      })).rejects.toThrow('X402 payments not enabled');
    });

    it('should throw error when payment address is not set', async () => {
      process.env.X402_ENABLED = 'true';
      delete process.env.X402_PAYMENT_ADDRESS;
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      await expect(service.createPaymentRequest({
        amount: 10,
        currency: 'USDC',
        appUrn: 'test-app',
        userId: 123,
      })).rejects.toThrow();
    });

    it('should create valid payment request when configured', async () => {
      process.env.X402_ENABLED = 'true';
      process.env.X402_PAYMENT_ADDRESS = '0x1234567890abcdef';
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      const request = await service.createPaymentRequest({
        amount: 10,
        currency: 'USDC',
        appUrn: 'test-app',
        userId: 123,
      });
      
      expect(request).toHaveProperty('id');
      expect(request).toHaveProperty('protocol', 'x402');
      expect(request).toHaveProperty('version', '1.0');
      expect(request).toHaveProperty('paymentAddress', '0x1234567890abcdef');
      expect(request).toHaveProperty('amount', 10);
      expect(request).toHaveProperty('currency', 'USDC');
      expect(request).toHaveProperty('metadata');
      expect(request.metadata).toEqual({
        appUrn: 'test-app',
        userId: 123,
      });
    });

    it('should include X402 HTTP headers in payment request', async () => {
      process.env.X402_ENABLED = 'true';
      process.env.X402_PAYMENT_ADDRESS = '0x1234567890abcdef';
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      const request = await service.createPaymentRequest({
        amount: 25.50,
        currency: 'ETH',
        appUrn: 'premium-app',
        userId: 456,
      });
      
      expect(request).toHaveProperty('httpHeaders');
      expect(request.httpHeaders).toHaveProperty('X-Payment-Address', '0x1234567890abcdef');
      expect(request.httpHeaders).toHaveProperty('X-Payment-Amount', '25.5');
      expect(request.httpHeaders).toHaveProperty('X-Payment-Currency', 'ETH');
      expect(request.httpHeaders).toHaveProperty('X-Payment-Id');
    });

    it('should generate unique payment IDs', async () => {
      process.env.X402_ENABLED = 'true';
      process.env.X402_PAYMENT_ADDRESS = '0x1234567890abcdef';
      
      const { X402Service } = await import('../services/x402.js');
      const service = new X402Service();
      
      // Mock Date.now to get consistent but different timestamps
      const originalNow = Date.now;
      let counter = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => 1000000 + counter++);
      
      const request1 = await service.createPaymentRequest({
        amount: 10,
        currency: 'BTC',
        appUrn: 'test-app',
        userId: 123,
      });
      
      const request2 = await service.createPaymentRequest({
        amount: 10,
        currency: 'BTC',
        appUrn: 'test-app',
        userId: 123,
      });
      
      expect(request1.id).not.toBe(request2.id);
      
      Date.now = originalNow;
    });
  });
});
