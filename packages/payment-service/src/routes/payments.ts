import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDatabase } from '../database.js';
import { StripeService } from '../services/stripe.js';
import { X402Service } from '../services/x402.js';
import { authenticateRequest } from '../middleware/auth.js';
import { dbRateLimit } from '../middleware/rate-limit.js';

export const paymentsRouter = Router();

// Apply authentication to all payment routes
paymentsRouter.use(authenticateRequest);

// Types for database records
interface SubscriptionRecord {
  id: number;
  app_urn: string;
  user_id: number;
  payment_method: 'stripe' | 'x402';
  amount: string;
  currency: string;
  interval: 'monthly' | 'yearly';
  status: 'active' | 'cancelled' | 'expired';
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

// Validation schemas
const createPaymentSchema = z.object({
  appUrn: z.string(),
  userId: z.number(),
  paymentMethod: z.enum(['stripe', 'x402']),
  amount: z.number().positive(),
  currency: z.string().default('USD'),
});

const processStripePaymentSchema = z.object({
  stripePaymentIntentId: z.string(),
});

const processX402PaymentSchema = z.object({
  transactionHash: z.string(),
});

// Create a new payment
paymentsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = createPaymentSchema.parse(req.body);
    const db = getDatabase();

    const stmt = db.prepare(`
      INSERT INTO payments (app_urn, user_id, payment_method, amount, currency, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `);

    const result = stmt.run(
      body.appUrn,
      body.userId,
      body.paymentMethod,
      body.amount.toString(),
      body.currency
    );

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json(payment);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    console.error('Error creating payment:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// Process Stripe payment
paymentsRouter.post('/:id/stripe/process', async (req: Request, res: Response) => {
  try {
    const paymentId = parseInt(req.params.id);
    const body = processStripePaymentSchema.parse(req.body);
    const db = getDatabase();

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const stripeService = new StripeService();
    const verified = await stripeService.verifyPayment(body.stripePaymentIntentId);

    if (verified) {
      db.prepare(`
        UPDATE payments 
        SET status = 'completed', stripe_payment_intent_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(body.stripePaymentIntentId, paymentId);
      return res.json({ success: true });
    }

    db.prepare(`
      UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?
    `).run(paymentId);
    res.json({ success: false });
  } catch (error) {
    console.error('Error processing Stripe payment:', error);
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

// Process X402 payment
paymentsRouter.post('/:id/x402/process', async (req: Request, res: Response) => {
  try {
    const paymentId = parseInt(req.params.id);
    const body = processX402PaymentSchema.parse(req.body);
    const db = getDatabase();

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const x402Service = new X402Service();
    const verified = await x402Service.verifyPayment(body.transactionHash);

    if (verified) {
      db.prepare(`
        UPDATE payments 
        SET status = 'completed', x402_transaction_hash = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(body.transactionHash, paymentId);
      return res.json({ success: true });
    }

    db.prepare(`
      UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?
    `).run(paymentId);
    res.json({ success: false });
  } catch (error) {
    console.error('Error processing X402 payment:', error);
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

// Get user payments
paymentsRouter.get('/user/:userId', (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const db = getDatabase();

    const payments = db.prepare(`
      SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC
    `).all(userId);

    res.json(payments);
  } catch (error) {
    console.error('Error fetching user payments:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// Get all payments for an app (admin endpoint)
paymentsRouter.get('/app/:appUrn', (req: Request, res: Response) => {
  try {
    const { appUrn } = req.params;
    const db = getDatabase();

    const payments = db.prepare(`
      SELECT * FROM payments 
      WHERE app_urn = ?
      ORDER BY created_at DESC
    `).all(appUrn);

    res.json(payments);
  } catch (error) {
    console.error('Error fetching app payments:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// Check payment status for app - rate limited for database access
paymentsRouter.get('/check/:appUrn/:userId', dbRateLimit, (req: Request, res: Response) => {
  try {
    const { appUrn, userId } = req.params;
    const db = getDatabase();

    const payments = db.prepare(`
      SELECT * FROM payments 
      WHERE app_urn = ? AND user_id = ? AND status = 'completed'
      ORDER BY created_at DESC
    `).all(appUrn, parseInt(userId));

    const subscription = db.prepare(`
      SELECT * FROM subscriptions 
      WHERE app_urn = ? AND user_id = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(appUrn, parseInt(userId));

    res.json({
      hasPaid: payments.length > 0,
      activeSubscription: subscription || null,
    });
  } catch (error) {
    console.error('Error checking payment status:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// Cancel subscription
paymentsRouter.post('/subscriptions/:id/cancel', async (req: Request, res: Response) => {
  try {
    const subscriptionId = parseInt(req.params.id);
    const db = getDatabase();

    const subscription = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId) as SubscriptionRecord | undefined;
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    // Cancel on Stripe if applicable
    if (subscription.payment_method === 'stripe' && subscription.stripe_subscription_id) {
      const stripeService = new StripeService();
      await stripeService.cancelSubscription(subscription.stripe_subscription_id);
    }

    db.prepare(`
      UPDATE subscriptions 
      SET status = 'cancelled', cancelled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(subscriptionId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Create Stripe checkout session
paymentsRouter.post('/stripe/checkout', async (req: Request, res: Response) => {
  try {
    const body = z.object({
      priceId: z.string(),
      appUrn: z.string(),
      userId: z.number(),
      successUrl: z.string().url(),
      cancelUrl: z.string().url(),
    }).parse(req.body);

    const stripeService = new StripeService();
    const session = await stripeService.createCheckoutSession(body);

    res.json(session);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Create Stripe payment intent
paymentsRouter.post('/stripe/payment-intent', async (req: Request, res: Response) => {
  try {
    const body = z.object({
      amount: z.number().positive(),
      currency: z.string(),
      appUrn: z.string(),
      userId: z.number(),
    }).parse(req.body);

    const stripeService = new StripeService();
    const paymentIntent = await stripeService.createPaymentIntent(body);

    res.json(paymentIntent);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

// Create X402 payment request
paymentsRouter.post('/x402/payment-request', async (req: Request, res: Response) => {
  try {
    const body = z.object({
      amount: z.number().positive(),
      currency: z.string(),
      appUrn: z.string(),
      userId: z.number(),
    }).parse(req.body);

    const x402Service = new X402Service();
    const paymentRequest = await x402Service.createPaymentRequest(body);

    res.json(paymentRequest);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    console.error('Error creating X402 payment request:', error);
    res.status(500).json({ error: 'Failed to create payment request' });
  }
});

// Get X402 supported currencies
paymentsRouter.get('/x402/currencies', (req: Request, res: Response) => {
  const x402Service = new X402Service();
  res.json(x402Service.getSupportedCurrencies());
});

// Check if X402 is enabled
paymentsRouter.get('/x402/status', (req: Request, res: Response) => {
  const x402Service = new X402Service();
  res.json({ enabled: x402Service.isEnabled() });
});
