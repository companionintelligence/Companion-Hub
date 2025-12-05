import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { X402Service } from '../x402.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('X402Service', () => {
  let x402Service: X402Service;
  let configService = mock<ConfigurationService>();
  let loggerService = mock<LoggerService>();

  beforeEach(async () => {
    // Reset environment variables
    vi.stubEnv('X402_ENABLED', 'true');
    vi.stubEnv('X402_PAYMENT_ADDRESS', '0x1234567890abcdef1234567890abcdef12345678');

    const moduleRef = await Test.createTestingModule({
      providers: [X402Service],
    })
      .useMocker(mock)
      .compile();

    x402Service = moduleRef.get(X402Service);
    configService = moduleRef.get(ConfigurationService);
    loggerService = moduleRef.get(LoggerService);
  });

  it('should be defined', () => {
    expect(x402Service).toBeDefined();
  });

  describe('verifyPayment', () => {
    it('should verify a valid transaction hash', async () => {
      const result = await x402Service.verifyPayment('0xabc123def456');

      expect(result).toBe(true);
      expect(loggerService.info).toHaveBeenCalledWith('Verifying X402 transaction: 0xabc123def456');
    });

    it('should return false when X402 is not enabled', async () => {
      vi.stubEnv('X402_ENABLED', 'false');

      const moduleRef = await Test.createTestingModule({
        providers: [X402Service],
      })
        .useMocker(mock)
        .compile();

      const serviceDisabled = moduleRef.get(X402Service);
      const result = await serviceDisabled.verifyPayment('0xabc123def456');

      expect(result).toBe(false);
    });

    it('should log a warning when X402 is not enabled', async () => {
      vi.stubEnv('X402_ENABLED', 'false');

      const moduleRef = await Test.createTestingModule({
        providers: [X402Service],
      })
        .useMocker(mock)
        .compile();

      const serviceDisabled = moduleRef.get(X402Service);
      const logger = moduleRef.get(LoggerService);
      await serviceDisabled.verifyPayment('0xabc123def456');

      expect(logger.warn).toHaveBeenCalledWith('X402 payments not enabled');
    });

    it('should handle various transaction hash formats', async () => {
      const validHashes = [
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        '0xABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890',
        'abc123',
      ];

      for (const hash of validHashes) {
        const result = await x402Service.verifyPayment(hash);
        expect(result).toBe(true);
      }
    });
  });

  describe('createPaymentRequest', () => {
    it('should create a payment request with valid parameters', async () => {
      const params = {
        amount: 9.99,
        currency: 'USD',
        appUrn: 'test-app:store',
        userId: 1,
      };

      const result = await x402Service.createPaymentRequest(params);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('protocol', 'x402');
      expect(result).toHaveProperty('version', '1.0');
      expect(result).toHaveProperty('paymentAddress');
      expect(result).toHaveProperty('amount', params.amount);
      expect(result).toHaveProperty('currency', params.currency);
      expect(result).toHaveProperty('metadata');
      expect(result.metadata).toEqual({ appUrn: params.appUrn, userId: params.userId });
      expect(result).toHaveProperty('httpHeaders');
      expect(loggerService.info).toHaveBeenCalledWith(`Created X402 payment request for ${params.appUrn}`);
    });

    it('should include correct HTTP headers in payment request', async () => {
      const params = {
        amount: 10,
        currency: 'BTC',
        appUrn: 'test-app:store',
        userId: 1,
      };

      const result = await x402Service.createPaymentRequest(params);

      expect(result.httpHeaders).toHaveProperty('X-Payment-Address');
      expect(result.httpHeaders).toHaveProperty('X-Payment-Amount', '10');
      expect(result.httpHeaders).toHaveProperty('X-Payment-Currency', 'BTC');
      expect(result.httpHeaders).toHaveProperty('X-Payment-Id');
    });

    it('should throw error when X402 is not enabled', async () => {
      vi.stubEnv('X402_ENABLED', 'false');

      const moduleRef = await Test.createTestingModule({
        providers: [X402Service],
      })
        .useMocker(mock)
        .compile();

      const serviceDisabled = moduleRef.get(X402Service);

      const params = {
        amount: 9.99,
        currency: 'USD',
        appUrn: 'test-app:store',
        userId: 1,
      };

      await expect(serviceDisabled.createPaymentRequest(params)).rejects.toThrow(
        'X402 payments not enabled or payment address not configured'
      );
    });

    it('should throw error when payment address is not configured', async () => {
      vi.stubEnv('X402_ENABLED', 'true');
      vi.stubEnv('X402_PAYMENT_ADDRESS', '');

      const moduleRef = await Test.createTestingModule({
        providers: [X402Service],
      })
        .useMocker(mock)
        .compile();

      const serviceNoAddress = moduleRef.get(X402Service);

      const params = {
        amount: 9.99,
        currency: 'USD',
        appUrn: 'test-app:store',
        userId: 1,
      };

      await expect(serviceNoAddress.createPaymentRequest(params)).rejects.toThrow(
        'X402 payments not enabled or payment address not configured'
      );
    });

    it('should generate unique payment IDs', async () => {
      const params = {
        amount: 9.99,
        currency: 'USD',
        appUrn: 'test-app:store',
        userId: 1,
      };

      const result1 = await x402Service.createPaymentRequest(params);
      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result2 = await x402Service.createPaymentRequest(params);

      expect(result1.id).not.toBe(result2.id);
      expect(result1.id).toMatch(/^x402_\d+_1$/);
      expect(result2.id).toMatch(/^x402_\d+_1$/);
    });
  });

  describe('getSupportedCurrencies', () => {
    it('should return list of supported cryptocurrencies', () => {
      const currencies = x402Service.getSupportedCurrencies();

      expect(Array.isArray(currencies)).toBe(true);
      expect(currencies.length).toBeGreaterThan(0);

      // Check structure of each currency
      for (const currency of currencies) {
        expect(currency).toHaveProperty('symbol');
        expect(currency).toHaveProperty('name');
        expect(currency).toHaveProperty('enabled');
      }
    });

    it('should include Bitcoin in supported currencies', () => {
      const currencies = x402Service.getSupportedCurrencies();
      const btc = currencies.find((c) => c.symbol === 'BTC');

      expect(btc).toBeDefined();
      expect(btc?.name).toBe('Bitcoin');
      expect(btc?.enabled).toBe(true);
    });

    it('should include Ethereum in supported currencies', () => {
      const currencies = x402Service.getSupportedCurrencies();
      const eth = currencies.find((c) => c.symbol === 'ETH');

      expect(eth).toBeDefined();
      expect(eth?.name).toBe('Ethereum');
      expect(eth?.enabled).toBe(true);
    });

    it('should include stablecoins (USDC, USDT)', () => {
      const currencies = x402Service.getSupportedCurrencies();
      const usdc = currencies.find((c) => c.symbol === 'USDC');
      const usdt = currencies.find((c) => c.symbol === 'USDT');

      expect(usdc).toBeDefined();
      expect(usdc?.name).toBe('USD Coin');

      expect(usdt).toBeDefined();
      expect(usdt?.name).toBe('Tether');
    });
  });

  describe('isEnabled', () => {
    it('should return true when X402 is enabled and address is configured', () => {
      expect(x402Service.isEnabled()).toBe(true);
    });

    it('should return false when X402 is disabled', async () => {
      vi.stubEnv('X402_ENABLED', 'false');

      const moduleRef = await Test.createTestingModule({
        providers: [X402Service],
      })
        .useMocker(mock)
        .compile();

      const serviceDisabled = moduleRef.get(X402Service);
      expect(serviceDisabled.isEnabled()).toBe(false);
    });

    it('should return false when payment address is not configured', async () => {
      vi.stubEnv('X402_ENABLED', 'true');
      vi.stubEnv('X402_PAYMENT_ADDRESS', '');

      const moduleRef = await Test.createTestingModule({
        providers: [X402Service],
      })
        .useMocker(mock)
        .compile();

      const serviceNoAddress = moduleRef.get(X402Service);
      expect(serviceNoAddress.isEnabled()).toBe(false);
    });

    it('should return false when both are not configured', async () => {
      vi.stubEnv('X402_ENABLED', 'false');
      vi.stubEnv('X402_PAYMENT_ADDRESS', '');

      const moduleRef = await Test.createTestingModule({
        providers: [X402Service],
      })
        .useMocker(mock)
        .compile();

      const serviceNotConfigured = moduleRef.get(X402Service);
      expect(serviceNotConfigured.isEnabled()).toBe(false);
    });
  });
});
