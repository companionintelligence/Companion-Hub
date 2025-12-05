import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { PaymentsService } from '../payments.service';
import { LoggerService } from '@/core/logger/logger.service';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('PaymentsService', () => {
  let paymentsService: PaymentsService;
  let loggerService = mock<LoggerService>();

  beforeEach(async () => {
    vi.stubEnv('PAYMENT_SERVICE_URL', 'http://localhost:3001');
    vi.stubEnv('PAYMENT_API_KEY', 'test-api-key');

    mockFetch.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [PaymentsService],
    })
      .useMocker(mock)
      .compile();

    paymentsService = moduleRef.get(PaymentsService);
    loggerService = moduleRef.get(LoggerService);
  });

  it('should be defined', () => {
    expect(paymentsService).toBeDefined();
  });

  describe('createPayment', () => {
    it('should call payment service to create a payment', async () => {
      const mockPayment = {
        id: 1,
        app_urn: 'test-app:store',
        user_id: 1,
        payment_method: 'stripe',
        amount: '9.99',
        currency: 'USD',
        status: 'pending',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockPayment),
      });

      const result = await paymentsService.createPayment({
        appUrn: 'test-app:store',
        userId: 1,
        paymentMethod: 'stripe',
        amount: 9.99,
        currency: 'USD',
      });

      expect(result).toEqual(mockPayment);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/payments',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-api-key',
          }),
        })
      );
    });

    it('should throw error when payment service returns error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal server error' }),
      });

      await expect(
        paymentsService.createPayment({
          appUrn: 'test-app:store',
          userId: 1,
          paymentMethod: 'stripe',
          amount: 9.99,
          currency: 'USD',
        })
      ).rejects.toThrow('Internal server error');
    });
  });

  describe('processStripePayment', () => {
    it('should call payment service to process Stripe payment', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const result = await paymentsService.processStripePayment(1, 'pi_test_123');

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/payments/1/stripe/process',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });
  });

  describe('processX402Payment', () => {
    it('should call payment service to process X402 payment', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const result = await paymentsService.processX402Payment(1, '0xabc123');

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/payments/1/x402/process',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });
  });

  describe('hasUserPaidForApp', () => {
    it('should return true when user has paid', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hasPaid: true, activeSubscription: null }),
      });

      const result = await paymentsService.hasUserPaidForApp(1, 'test-app:store');

      expect(result).toBe(true);
    });

    it('should return false when user has not paid', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hasPaid: false, activeSubscription: null }),
      });

      const result = await paymentsService.hasUserPaidForApp(1, 'test-app:store');

      expect(result).toBe(false);
    });
  });

  describe('cancelSubscription', () => {
    it('should call payment service to cancel subscription', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const result = await paymentsService.cancelSubscription(1);

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/payments/subscriptions/1/cancel',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });
  });

  describe('createStripeCheckoutSession', () => {
    it('should call payment service to create checkout session', async () => {
      const mockSession = { id: 'cs_test_123', url: 'https://checkout.stripe.com/...' };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSession),
      });

      const result = await paymentsService.createStripeCheckoutSession({
        priceId: 'price_123',
        appUrn: 'test-app:store',
        userId: 1,
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });

      expect(result).toEqual(mockSession);
    });
  });

  describe('isX402Enabled', () => {
    it('should return true when X402 is enabled', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ enabled: true }),
      });

      const result = await paymentsService.isX402Enabled();

      expect(result).toBe(true);
    });

    it('should return false when X402 is disabled', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ enabled: false }),
      });

      const result = await paymentsService.isX402Enabled();

      expect(result).toBe(false);
    });
  });
});
