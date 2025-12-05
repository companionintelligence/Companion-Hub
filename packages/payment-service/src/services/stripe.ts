import Stripe from 'stripe';

export class StripeService {
  private stripe: Stripe | null = null;
  private stripeApiKey: string | undefined;

  constructor() {
    this.stripeApiKey = process.env.STRIPE_SECRET_KEY;
    if (this.stripeApiKey) {
      this.stripe = new Stripe(this.stripeApiKey);
    }
  }

  /**
   * Verify a Stripe payment intent
   */
  async verifyPayment(paymentIntentId: string): Promise<boolean> {
    if (!this.stripe) {
      console.warn('Stripe API key not configured');
      return false;
    }

    try {
      const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
      return paymentIntent.status === 'succeeded';
    } catch (error) {
      console.error('Failed to verify Stripe payment:', error);
      return false;
    }
  }

  /**
   * Create a Stripe checkout session
   */
  async createCheckoutSession(params: {
    priceId: string;
    appUrn: string;
    userId: number;
    successUrl: string;
    cancelUrl: string;
  }) {
    if (!this.stripe) {
      throw new Error('Stripe API key not configured');
    }

    try {
      const session = await this.stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: params.priceId, quantity: 1 }],
        mode: 'subscription',
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata: {
          appUrn: params.appUrn,
          userId: String(params.userId),
        },
      });

      return {
        id: session.id,
        url: session.url,
      };
    } catch (error) {
      console.error('Failed to create Stripe checkout session:', error);
      throw error;
    }
  }

  /**
   * Cancel a Stripe subscription
   */
  async cancelSubscription(subscriptionId: string): Promise<boolean> {
    if (!this.stripe) {
      console.warn('Stripe API key not configured');
      return false;
    }

    try {
      await this.stripe.subscriptions.cancel(subscriptionId);
      return true;
    } catch (error) {
      console.error('Failed to cancel Stripe subscription:', error);
      return false;
    }
  }

  /**
   * Create a payment intent for one-time payments
   */
  async createPaymentIntent(params: {
    amount: number;
    currency: string;
    appUrn: string;
    userId: number;
  }) {
    if (!this.stripe) {
      throw new Error('Stripe API key not configured');
    }

    try {
      // Convert to cents using integer arithmetic to avoid floating point errors
      // Multiply first, then round to handle decimal precision correctly
      const amountInCents = Math.round(Number((params.amount * 100).toFixed(2)));
      
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: amountInCents,
        currency: params.currency.toLowerCase(),
        metadata: {
          appUrn: params.appUrn,
          userId: String(params.userId),
        },
      });

      return {
        id: paymentIntent.id,
        client_secret: paymentIntent.client_secret,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
      };
    } catch (error) {
      console.error('Failed to create Stripe payment intent:', error);
      throw error;
    }
  }

  /**
   * Check if Stripe is configured
   */
  isConfigured(): boolean {
    return Boolean(this.stripe);
  }
}
