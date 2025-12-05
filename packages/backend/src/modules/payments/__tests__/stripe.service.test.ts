import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { StripeService } from '../stripe.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('StripeService', () => {
  let stripeService: StripeService;
  let configService = mock<ConfigurationService>();
  let loggerService = mock<LoggerService>();

  beforeEach(async () => {
    // Reset environment variables
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_12345');

    const moduleRef = await Test.createTestingModule({
      providers: [StripeService],
    })
      .useMocker(mock)
      .compile();

    stripeService = moduleRef.get(StripeService);
    configService = moduleRef.get(ConfigurationService);
    loggerService = moduleRef.get(LoggerService);
  });

  it('should be defined', () => {
    expect(stripeService).toBeDefined();
  });

  describe('verifyPayment', () => {
    it('should verify a valid payment intent', async () => {
      const result = await stripeService.verifyPayment('pi_test_123456');

      expect(result).toBe(true);
      expect(loggerService.info).toHaveBeenCalledWith('Verifying Stripe payment: pi_test_123456');
    });

    it('should return false when Stripe API key is not configured', async () => {
      vi.stubEnv('STRIPE_SECRET_KEY', '');

      const moduleRef = await Test.createTestingModule({
        providers: [StripeService],
      })
        .useMocker(mock)
        .compile();

      const serviceWithoutKey = moduleRef.get(StripeService);
      const result = await serviceWithoutKey.verifyPayment('pi_test_123456');

      expect(result).toBe(false);
    });

    it('should log a warning when API key is not configured', async () => {
      vi.stubEnv('STRIPE_SECRET_KEY', '');

      const moduleRef = await Test.createTestingModule({
        providers: [StripeService],
      })
        .useMocker(mock)
        .compile();

      const serviceWithoutKey = moduleRef.get(StripeService);
      const logger = moduleRef.get(LoggerService);
      await serviceWithoutKey.verifyPayment('pi_test_123456');

      expect(logger.warn).toHaveBeenCalledWith('Stripe API key not configured');
    });
  });

  describe('createCheckoutSession', () => {
    it('should create a checkout session with valid parameters', async () => {
      const params = {
        priceId: 'price_test_123',
        appUrn: 'test-app:store',
        userId: 1,
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      };

      const result = await stripeService.createCheckoutSession(params);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('url');
      expect(result.id).toMatch(/^cs_test_/);
      expect(result.url).toBe(params.successUrl);
      expect(loggerService.info).toHaveBeenCalledWith(`Creating Stripe checkout session for ${params.appUrn}`);
    });

    it('should throw error when API key is not configured', async () => {
      vi.stubEnv('STRIPE_SECRET_KEY', '');

      const moduleRef = await Test.createTestingModule({
        providers: [StripeService],
      })
        .useMocker(mock)
        .compile();

      const serviceWithoutKey = moduleRef.get(StripeService);

      const params = {
        priceId: 'price_test_123',
        appUrn: 'test-app:store',
        userId: 1,
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      };

      await expect(serviceWithoutKey.createCheckoutSession(params)).rejects.toThrow('Stripe API key not configured');
    });
  });

  describe('cancelSubscription', () => {
    it('should cancel a subscription successfully', async () => {
      const result = await stripeService.cancelSubscription('sub_test_123456');

      expect(result).toBe(true);
      expect(loggerService.info).toHaveBeenCalledWith('Cancelling Stripe subscription: sub_test_123456');
    });

    it('should return false when API key is not configured', async () => {
      vi.stubEnv('STRIPE_SECRET_KEY', '');

      const moduleRef = await Test.createTestingModule({
        providers: [StripeService],
      })
        .useMocker(mock)
        .compile();

      const serviceWithoutKey = moduleRef.get(StripeService);
      const result = await serviceWithoutKey.cancelSubscription('sub_test_123456');

      expect(result).toBe(false);
    });
  });

  describe('createPaymentIntent', () => {
    it('should create a payment intent with valid parameters', async () => {
      const params = {
        amount: 9.99,
        currency: 'USD',
        appUrn: 'test-app:store',
        userId: 1,
      };

      const result = await stripeService.createPaymentIntent(params);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('client_secret');
      expect(result).toHaveProperty('amount');
      expect(result).toHaveProperty('currency');
      expect(result.id).toMatch(/^pi_test_/);
      expect(result.amount).toBe(999); // Amount in cents
      expect(result.currency).toBe('usd');
      expect(loggerService.info).toHaveBeenCalledWith(`Creating Stripe payment intent for ${params.appUrn}`);
    });

    it('should throw error when API key is not configured', async () => {
      vi.stubEnv('STRIPE_SECRET_KEY', '');

      const moduleRef = await Test.createTestingModule({
        providers: [StripeService],
      })
        .useMocker(mock)
        .compile();

      const serviceWithoutKey = moduleRef.get(StripeService);

      const params = {
        amount: 9.99,
        currency: 'USD',
        appUrn: 'test-app:store',
        userId: 1,
      };

      await expect(serviceWithoutKey.createPaymentIntent(params)).rejects.toThrow('Stripe API key not configured');
    });

    it('should convert amount to cents correctly', async () => {
      const testCases = [
        { amount: 10, expectedCents: 1000 },
        { amount: 9.99, expectedCents: 999 },
        { amount: 0.50, expectedCents: 50 },
        { amount: 100, expectedCents: 10000 },
      ];

      for (const { amount, expectedCents } of testCases) {
        const result = await stripeService.createPaymentIntent({
          amount,
          currency: 'USD',
          appUrn: 'test-app:store',
          userId: 1,
        });

        expect(result.amount).toBe(expectedCents);
      }
    });

    it('should convert currency to lowercase', async () => {
      const testCases = ['USD', 'EUR', 'GBP', 'usd', 'Eur'];

      for (const currency of testCases) {
        const result = await stripeService.createPaymentIntent({
          amount: 10,
          currency,
          appUrn: 'test-app:store',
          userId: 1,
        });

        expect(result.currency).toBe(currency.toLowerCase());
      }
    });
  });
});
