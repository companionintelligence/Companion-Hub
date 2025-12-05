import { describe, it, expect } from 'vitest';
import { pricingSchema, pricingSchemaArk, PRICING_TYPES, SUBSCRIPTION_INTERVALS, PAYMENT_METHODS } from '../app-info.js';
import { type } from 'arktype';

type ValidationResult<T> = { success: true; data: T } | { success: false };

// biome-ignore lint/suspicious/noExplicitAny: test utility
function safeParseArk<T>(schema: any, data: unknown): ValidationResult<T> {
  const result = schema(data);

  if (result instanceof type.errors) {
    return { success: false };
  }

  return { success: true, data: result as T };
}

describe('Pricing Schema Tests', () => {
  describe('Constants', () => {
    it('should have correct pricing types', () => {
      expect(PRICING_TYPES).toEqual(['free', 'one_time', 'subscription']);
    });

    it('should have correct subscription intervals', () => {
      expect(SUBSCRIPTION_INTERVALS).toEqual(['monthly', 'yearly']);
    });

    it('should have correct payment methods', () => {
      expect(PAYMENT_METHODS).toEqual(['stripe', 'x402']);
    });
  });

  describe('Zod Schema', () => {
    describe('Free Pricing', () => {
      it('should validate free pricing with minimal fields', () => {
        const pricing = { type: 'free' };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.type).toBe('free');
          expect(result.data.currency).toBe('USD');
        }
      });

      it('should default to free when no type is specified', () => {
        const pricing = {};
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.type).toBe('free');
        }
      });
    });

    describe('One-Time Payment', () => {
      it('should validate one-time payment with price', () => {
        const pricing = {
          type: 'one_time',
          price: 9.99,
          currency: 'USD',
          payment_methods: ['stripe'],
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.type).toBe('one_time');
          expect(result.data.price).toBe(9.99);
        }
      });

      it('should accept integer prices', () => {
        const pricing = {
          type: 'one_time',
          price: 10,
          currency: 'EUR',
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(true);
      });

      it('should reject negative prices', () => {
        const pricing = {
          type: 'one_time',
          price: -5,
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(false);
      });
    });

    describe('Subscription Pricing', () => {
      it('should validate monthly subscription', () => {
        const pricing = {
          type: 'subscription',
          price: 4.99,
          currency: 'USD',
          interval: 'monthly',
          payment_methods: ['stripe', 'x402'],
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.type).toBe('subscription');
          expect(result.data.interval).toBe('monthly');
        }
      });

      it('should validate yearly subscription', () => {
        const pricing = {
          type: 'subscription',
          price: 49.99,
          currency: 'USD',
          interval: 'yearly',
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(true);
      });

      it('should reject invalid interval', () => {
        const pricing = {
          type: 'subscription',
          price: 9.99,
          interval: 'weekly',
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(false);
      });
    });

    describe('Payment Methods', () => {
      it('should validate stripe payment method', () => {
        const pricing = {
          type: 'one_time',
          price: 10,
          payment_methods: ['stripe'],
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(true);
      });

      it('should validate x402 payment method', () => {
        const pricing = {
          type: 'one_time',
          price: 10,
          payment_methods: ['x402'],
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(true);
      });

      it('should validate multiple payment methods', () => {
        const pricing = {
          type: 'one_time',
          price: 10,
          payment_methods: ['stripe', 'x402'],
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(true);
      });

      it('should reject invalid payment method', () => {
        const pricing = {
          type: 'one_time',
          price: 10,
          payment_methods: ['paypal'],
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(false);
      });
    });

    describe('Stripe Integration', () => {
      it('should accept stripe_price_id', () => {
        const pricing = {
          type: 'subscription',
          price: 9.99,
          interval: 'monthly',
          payment_methods: ['stripe'],
          stripe_price_id: 'price_1234567890',
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.stripe_price_id).toBe('price_1234567890');
        }
      });
    });

    describe('X402 Integration', () => {
      it('should accept x402_resource', () => {
        const pricing = {
          type: 'one_time',
          price: 10,
          payment_methods: ['x402'],
          x402_resource: 'resource_id_123',
        };
        const result = pricingSchema.safeParse(pricing);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.x402_resource).toBe('resource_id_123');
        }
      });
    });
  });

  describe('ArkType Schema', () => {
    describe('Free Pricing', () => {
      it('should validate free pricing with minimal fields', () => {
        const pricing = { type: 'free' };
        const result = safeParseArk(pricingSchemaArk, pricing);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.type).toBe('free');
        }
      });
    });

    describe('One-Time Payment', () => {
      it('should validate one-time payment with price', () => {
        const pricing = {
          type: 'one_time',
          price: 9.99,
          currency: 'USD',
          payment_methods: ['stripe'],
        };
        const result = safeParseArk(pricingSchemaArk, pricing);
        expect(result.success).toBe(true);
      });
    });

    describe('Subscription Pricing', () => {
      it('should validate subscription with interval', () => {
        const pricing = {
          type: 'subscription',
          price: 4.99,
          interval: 'monthly',
          payment_methods: ['stripe', 'x402'],
        };
        const result = safeParseArk(pricingSchemaArk, pricing);
        expect(result.success).toBe(true);
      });
    });
  });
});
