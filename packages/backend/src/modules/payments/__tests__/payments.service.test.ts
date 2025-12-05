import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { PaymentsService } from '../payments.service';
import { PaymentsRepository } from '../payments.repository';
import { StripeService } from '../stripe.service';
import { X402Service } from '../x402.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('PaymentsService', () => {
  let paymentsService: PaymentsService;
  let paymentsRepository = mock<PaymentsRepository>();
  let stripeService = mock<StripeService>();
  let x402Service = mock<X402Service>();
  let loggerService = mock<LoggerService>();

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PaymentsService],
    })
      .useMocker(mock)
      .compile();

    paymentsService = moduleRef.get(PaymentsService);
    paymentsRepository = moduleRef.get(PaymentsRepository);
    stripeService = moduleRef.get(StripeService);
    x402Service = moduleRef.get(X402Service);
    loggerService = moduleRef.get(LoggerService);
  });

  it('should be defined', () => {
    expect(paymentsService).toBeDefined();
  });

  describe('createPayment', () => {
    it('should create a payment record', async () => {
      const mockPayment = {
        id: 1,
        appUrn: 'test-app:store',
        userId: 1,
        paymentMethod: 'stripe' as const,
        amount: '9.99',
        currency: 'USD',
        status: 'pending' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      paymentsRepository.createPayment.mockResolvedValue(mockPayment);

      const result = await paymentsService.createPayment({
        appUrn: 'test-app:store',
        userId: 1,
        paymentMethod: 'stripe',
        amount: 9.99,
        currency: 'USD',
      });

      expect(result).toEqual(mockPayment);
      expect(paymentsRepository.createPayment).toHaveBeenCalledWith({
        appUrn: 'test-app:store',
        userId: 1,
        paymentMethod: 'stripe',
        amount: '9.99',
        currency: 'USD',
        status: 'pending',
      });
    });
  });

  describe('processStripePayment', () => {
    it('should process and complete a valid Stripe payment', async () => {
      const mockPayment = {
        id: 1,
        appUrn: 'test-app:store',
        userId: 1,
        paymentMethod: 'stripe' as const,
        amount: '9.99',
        currency: 'USD',
        status: 'pending' as const,
      };

      paymentsRepository.getPaymentById.mockResolvedValue(mockPayment);
      stripeService.verifyPayment.mockResolvedValue(true);

      const result = await paymentsService.processStripePayment(1, 'pi_test_123');

      expect(result).toEqual({ success: true });
      expect(paymentsRepository.updatePaymentStatus).toHaveBeenCalledWith(
        1,
        'completed',
        { stripePaymentIntentId: 'pi_test_123' }
      );
    });

    it('should fail when payment is not found', async () => {
      paymentsRepository.getPaymentById.mockResolvedValue(null);

      await expect(paymentsService.processStripePayment(999, 'pi_test_123'))
        .rejects.toThrow('Payment not found');
    });

    it('should mark payment as failed when Stripe verification fails', async () => {
      const mockPayment = {
        id: 1,
        appUrn: 'test-app:store',
        userId: 1,
        paymentMethod: 'stripe' as const,
        amount: '9.99',
        currency: 'USD',
        status: 'pending' as const,
      };

      paymentsRepository.getPaymentById.mockResolvedValue(mockPayment);
      stripeService.verifyPayment.mockResolvedValue(false);

      const result = await paymentsService.processStripePayment(1, 'pi_test_123');

      expect(result).toEqual({ success: false });
      expect(paymentsRepository.updatePaymentStatus).toHaveBeenCalledWith(1, 'failed');
    });
  });

  describe('processX402Payment', () => {
    it('should process and complete a valid X402 payment', async () => {
      const mockPayment = {
        id: 1,
        appUrn: 'test-app:store',
        userId: 1,
        paymentMethod: 'x402' as const,
        amount: '9.99',
        currency: 'USD',
        status: 'pending' as const,
      };

      paymentsRepository.getPaymentById.mockResolvedValue(mockPayment);
      x402Service.verifyPayment.mockResolvedValue(true);

      const result = await paymentsService.processX402Payment(1, '0xabc123');

      expect(result).toEqual({ success: true });
      expect(paymentsRepository.updatePaymentStatus).toHaveBeenCalledWith(
        1,
        'completed',
        { x402TransactionHash: '0xabc123' }
      );
    });

    it('should fail when payment is not found', async () => {
      paymentsRepository.getPaymentById.mockResolvedValue(null);

      await expect(paymentsService.processX402Payment(999, '0xabc123'))
        .rejects.toThrow('Payment not found');
    });
  });

  describe('hasUserPaidForApp', () => {
    it('should return true when user has completed payment', async () => {
      const mockPayments = [
        { id: 1, status: 'completed' },
      ];

      paymentsRepository.getPaymentsByUserAndApp.mockResolvedValue(mockPayments);

      const result = await paymentsService.hasUserPaidForApp(1, 'test-app:store');

      expect(result).toBe(true);
    });

    it('should return false when user has no completed payments', async () => {
      const mockPayments = [
        { id: 1, status: 'pending' },
        { id: 2, status: 'failed' },
      ];

      paymentsRepository.getPaymentsByUserAndApp.mockResolvedValue(mockPayments);

      const result = await paymentsService.hasUserPaidForApp(1, 'test-app:store');

      expect(result).toBe(false);
    });

    it('should return false when user has no payments', async () => {
      paymentsRepository.getPaymentsByUserAndApp.mockResolvedValue([]);

      const result = await paymentsService.hasUserPaidForApp(1, 'test-app:store');

      expect(result).toBe(false);
    });
  });

  describe('cancelSubscription', () => {
    it('should cancel a Stripe subscription', async () => {
      const mockSubscription = {
        id: 1,
        paymentMethod: 'stripe',
        stripeSubscriptionId: 'sub_test_123',
      };

      paymentsRepository.getSubscriptionById.mockResolvedValue(mockSubscription);
      stripeService.cancelSubscription.mockResolvedValue(true);

      const result = await paymentsService.cancelSubscription(1);

      expect(result).toEqual({ success: true });
      expect(stripeService.cancelSubscription).toHaveBeenCalledWith('sub_test_123');
      expect(paymentsRepository.cancelSubscription).toHaveBeenCalledWith(1);
    });

    it('should fail when subscription is not found', async () => {
      paymentsRepository.getSubscriptionById.mockResolvedValue(null);

      await expect(paymentsService.cancelSubscription(999))
        .rejects.toThrow('Subscription not found');
    });
  });
});
