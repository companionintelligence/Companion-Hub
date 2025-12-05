import { type } from 'arktype';

export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'refunded';
export type SubscriptionStatus = 'active' | 'cancelled' | 'expired';

export const createPaymentSchema = type({
  appUrn: 'string',
  paymentMethod: type.enumerated('stripe', 'x402'),
  amount: 'number >= 0',
  currency: 'string',
  userId: 'number?',
});

export type CreatePaymentDto = typeof createPaymentSchema.infer;

export const processStripePaymentSchema = type({
  stripePaymentIntentId: 'string',
});

export type ProcessStripePaymentDto = typeof processStripePaymentSchema.infer;

export const processX402PaymentSchema = type({
  transactionHash: 'string',
});

export type ProcessX402PaymentDto = typeof processX402PaymentSchema.infer;

export const paymentResponseSchema = type({
  id: 'number',
  appUrn: 'string',
  userId: 'number',
  paymentMethod: type.enumerated('stripe', 'x402'),
  amount: 'number',
  currency: 'string',
  status: type.enumerated('pending', 'completed', 'failed', 'refunded'),
  createdAt: 'string',
  updatedAt: 'string',
});

export type PaymentResponse = typeof paymentResponseSchema.infer;

export const subscriptionResponseSchema = type({
  id: 'number',
  appUrn: 'string',
  userId: 'number',
  paymentMethod: type.enumerated('stripe', 'x402'),
  amount: 'number',
  currency: 'string',
  interval: type.enumerated('monthly', 'yearly'),
  status: type.enumerated('active', 'cancelled', 'expired'),
  createdAt: 'string',
  expiresAt: 'string?',
  cancelledAt: 'string?',
});

export type SubscriptionResponse = typeof subscriptionResponseSchema.infer;
