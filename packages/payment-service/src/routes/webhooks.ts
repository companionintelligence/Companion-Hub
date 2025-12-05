import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { getDatabase } from '../database.js';

export const webhooksRouter = Router();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Stripe webhook handler
webhooksRouter.post('/stripe', async (req: Request, res: Response) => {
  if (!stripeSecretKey || !webhookSecret) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const stripe = new Stripe(stripeSecretKey);
  const sig = req.headers['stripe-signature'] as string;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const db = getDatabase();

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        
        // Update payment status
        db.prepare(`
          UPDATE payments 
          SET status = 'completed', updated_at = datetime('now')
          WHERE stripe_payment_intent_id = ?
        `).run(paymentIntent.id);
        
        console.log(`Payment ${paymentIntent.id} succeeded`);
        break;
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        
        db.prepare(`
          UPDATE payments 
          SET status = 'failed', updated_at = datetime('now')
          WHERE stripe_payment_intent_id = ?
        `).run(paymentIntent.id);
        
        console.log(`Payment ${paymentIntent.id} failed`);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const metadata = subscription.metadata;
        
        if (metadata.appUrn && metadata.userId) {
          // Check if subscription exists
          const existing = db.prepare(`
            SELECT id FROM subscriptions WHERE stripe_subscription_id = ?
          `).get(subscription.id);

          if (existing) {
            db.prepare(`
              UPDATE subscriptions 
              SET status = ?, 
                  current_period_start = ?, 
                  current_period_end = ?,
                  updated_at = datetime('now')
              WHERE stripe_subscription_id = ?
            `).run(
              subscription.status === 'active' ? 'active' : 'cancelled',
              new Date(subscription.current_period_start * 1000).toISOString(),
              new Date(subscription.current_period_end * 1000).toISOString(),
              subscription.id
            );
          } else {
            const item = subscription.items.data[0];
            // Store amount in cents (integer) to avoid floating point precision issues
            // Convert to string for SQLite storage
            const amountInCents = item.price.unit_amount || 0;
            
            db.prepare(`
              INSERT INTO subscriptions 
              (app_urn, user_id, payment_method, amount, currency, interval, status, stripe_subscription_id, current_period_start, current_period_end)
              VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?)
            `).run(
              metadata.appUrn,
              parseInt(metadata.userId),
              amountInCents.toString(), // Store as cents (integer string) for precision
              item.price.currency.toUpperCase(),
              item.price.recurring?.interval === 'year' ? 'yearly' : 'monthly',
              subscription.status === 'active' ? 'active' : 'cancelled',
              subscription.id,
              new Date(subscription.current_period_start * 1000).toISOString(),
              new Date(subscription.current_period_end * 1000).toISOString()
            );
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        
        db.prepare(`
          UPDATE subscriptions 
          SET status = 'cancelled', cancelled_at = datetime('now'), updated_at = datetime('now')
          WHERE stripe_subscription_id = ?
        `).run(subscription.id);
        
        console.log(`Subscription ${subscription.id} cancelled`);
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        
        if (charge.payment_intent) {
          db.prepare(`
            UPDATE payments 
            SET status = 'refunded', updated_at = datetime('now')
            WHERE stripe_payment_intent_id = ?
          `).run(charge.payment_intent);
        }
        
        console.log(`Charge ${charge.id} refunded`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});
