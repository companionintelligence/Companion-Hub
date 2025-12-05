import { Injectable } from '@nestjs/common';
import type { CreatePaymentDto } from './dto/payments.dto';
import { LoggerService } from '@/core/logger/logger.service';

interface CreatePaymentParams extends Omit<CreatePaymentDto, 'userId'> {
  userId: number;
}

/**
 * PaymentsService acts as a client to the isolated payment service
 * The actual payment processing happens in the separate payment-service container
 */
@Injectable()
export class PaymentsService {
  private paymentServiceUrl: string;
  private paymentApiKey: string | undefined;

  constructor(private readonly logger: LoggerService) {
    this.paymentServiceUrl = process.env.PAYMENT_SERVICE_URL || 'http://runtipi-payment:3001';
    this.paymentApiKey = process.env.PAYMENT_API_KEY;
  }

  private async fetchFromPaymentService<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(this.paymentApiKey ? { Authorization: `Bearer ${this.paymentApiKey}` } : {}),
    };

    const response = await fetch(`${this.paymentServiceUrl}${endpoint}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `Payment service error: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Create a new payment for an app
   */
  async createPayment(params: CreatePaymentParams) {
    const { appUrn, userId, paymentMethod, amount, currency } = params;

    this.logger.info(`Creating payment for app ${appUrn} by user ${userId}`);

    return this.fetchFromPaymentService('/api/payments', {
      method: 'POST',
      body: JSON.stringify({
        appUrn,
        userId,
        paymentMethod,
        amount,
        currency,
      }),
    });
  }

  /**
   * Process a Stripe payment
   */
  async processStripePayment(paymentId: number, stripePaymentIntentId: string) {
    return this.fetchFromPaymentService(`/api/payments/${paymentId}/stripe/process`, {
      method: 'POST',
      body: JSON.stringify({ stripePaymentIntentId }),
    });
  }

  /**
   * Process an X402 crypto payment
   */
  async processX402Payment(paymentId: number, transactionHash: string) {
    return this.fetchFromPaymentService(`/api/payments/${paymentId}/x402/process`, {
      method: 'POST',
      body: JSON.stringify({ transactionHash }),
    });
  }

  /**
   * Get payment history for a user
   */
  async getUserPayments(userId: number) {
    return this.fetchFromPaymentService(`/api/payments/user/${userId}`);
  }

  /**
   * Check if user has paid for an app
   */
  async hasUserPaidForApp(userId: number, appUrn: string) {
    const result = await this.fetchFromPaymentService<{ hasPaid: boolean }>(
      `/api/payments/check/${encodeURIComponent(appUrn)}/${userId}`,
    );
    return result.hasPaid;
  }

  /**
   * Get active subscription for a user and app
   */
  async getActiveSubscription(userId: number, appUrn: string) {
    const result = await this.fetchFromPaymentService<{ activeSubscription: any }>(
      `/api/payments/check/${encodeURIComponent(appUrn)}/${userId}`,
    );
    return result.activeSubscription;
  }

  /**
   * Cancel a subscription
   */
  async cancelSubscription(subscriptionId: number) {
    return this.fetchFromPaymentService(`/api/payments/subscriptions/${subscriptionId}/cancel`, {
      method: 'POST',
    });
  }

  /**
   * Create Stripe checkout session
   */
  async createStripeCheckoutSession(params: {
    priceId: string;
    appUrn: string;
    userId: number;
    successUrl: string;
    cancelUrl: string;
  }) {
    return this.fetchFromPaymentService('/api/payments/stripe/checkout', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /**
   * Create Stripe payment intent
   */
  async createStripePaymentIntent(params: {
    amount: number;
    currency: string;
    appUrn: string;
    userId: number;
  }) {
    return this.fetchFromPaymentService('/api/payments/stripe/payment-intent', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /**
   * Create X402 payment request
   */
  async createX402PaymentRequest(params: {
    amount: number;
    currency: string;
    appUrn: string;
    userId: number;
  }) {
    return this.fetchFromPaymentService('/api/payments/x402/payment-request', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  /**
   * Get X402 supported currencies
   */
  async getX402Currencies() {
    return this.fetchFromPaymentService('/api/payments/x402/currencies');
  }

  /**
   * Check if X402 is enabled
   */
  async isX402Enabled() {
    const result = await this.fetchFromPaymentService<{ enabled: boolean }>(
      '/api/payments/x402/status',
    );
    return result.enabled;
  }
}
