import { Injectable } from '@nestjs/common';
import type { PaymentsRepository } from './payments.repository';
import type { StripeService } from './stripe.service';
import type { X402Service } from './x402.service';
import type { CreatePaymentDto } from './dto/payments.dto';
import { LoggerService } from '@/core/logger/logger.service';

interface CreatePaymentParams extends Omit<CreatePaymentDto, 'userId'> {
  userId: number;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly paymentsRepository: PaymentsRepository,
    private readonly stripeService: StripeService,
    private readonly x402Service: X402Service,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Create a new payment for an app
   */
  async createPayment(params: CreatePaymentParams) {
    const { appUrn, userId, paymentMethod, amount, currency } = params;

    this.logger.info(`Creating payment for app ${appUrn} by user ${userId}`);

    // Create payment record
    const payment = await this.paymentsRepository.createPayment({
      appUrn,
      userId,
      paymentMethod,
      amount: String(amount),
      currency,
      status: 'pending',
    });

    return payment;
  }

  /**
   * Process a Stripe payment
   */
  async processStripePayment(paymentId: number, stripePaymentIntentId: string) {
    const payment = await this.paymentsRepository.getPaymentById(paymentId);

    if (!payment) {
      throw new Error('Payment not found');
    }

    // Verify payment with Stripe
    const verified = await this.stripeService.verifyPayment(stripePaymentIntentId);

    if (verified) {
      await this.paymentsRepository.updatePaymentStatus(paymentId, 'completed', {
        stripePaymentIntentId,
      });
      return { success: true };
    }

    await this.paymentsRepository.updatePaymentStatus(paymentId, 'failed');
    return { success: false };
  }

  /**
   * Process an X402 crypto payment
   */
  async processX402Payment(paymentId: number, transactionHash: string) {
    const payment = await this.paymentsRepository.getPaymentById(paymentId);

    if (!payment) {
      throw new Error('Payment not found');
    }

    // Verify payment with X402 protocol
    const verified = await this.x402Service.verifyPayment(transactionHash);

    if (verified) {
      await this.paymentsRepository.updatePaymentStatus(paymentId, 'completed', {
        x402TransactionHash: transactionHash,
      });
      return { success: true };
    }

    await this.paymentsRepository.updatePaymentStatus(paymentId, 'failed');
    return { success: false };
  }

  /**
   * Get payment history for a user
   */
  async getUserPayments(userId: number) {
    return this.paymentsRepository.getPaymentsByUserId(userId);
  }

  /**
   * Get payment history for an app
   */
  async getAppPayments(appUrn: string) {
    return this.paymentsRepository.getPaymentsByAppUrn(appUrn);
  }

  /**
   * Check if user has paid for an app
   */
  async hasUserPaidForApp(userId: number, appUrn: string) {
    const payments = await this.paymentsRepository.getPaymentsByUserAndApp(userId, appUrn);
    return payments.some((p) => p.status === 'completed');
  }

  /**
   * Get active subscription for a user and app
   */
  async getActiveSubscription(userId: number, appUrn: string) {
    return this.paymentsRepository.getActiveSubscription(userId, appUrn);
  }

  /**
   * Cancel a subscription
   */
  async cancelSubscription(subscriptionId: number) {
    const subscription = await this.paymentsRepository.getSubscriptionById(subscriptionId);

    if (!subscription) {
      throw new Error('Subscription not found');
    }

    if (subscription.paymentMethod === 'stripe' && subscription.stripeSubscriptionId) {
      await this.stripeService.cancelSubscription(subscription.stripeSubscriptionId);
    }

    await this.paymentsRepository.cancelSubscription(subscriptionId);
    return { success: true };
  }
}
