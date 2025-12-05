import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@/core/database/database.service';
import { payment, subscription } from '@/core/database/drizzle/schema';
import { eq, and, desc } from 'drizzle-orm';

type PaymentStatus = 'pending' | 'completed' | 'failed' | 'refunded';

interface CreatePaymentParams {
  appUrn: string;
  userId: number;
  paymentMethod: 'stripe' | 'x402';
  amount: string;
  currency: string;
  status: PaymentStatus;
}

interface PaymentMetadata {
  stripePaymentIntentId?: string;
  x402TransactionHash?: string;
}

@Injectable()
export class PaymentsRepository {
  constructor(private readonly db: DatabaseService) {}

  async createPayment(params: CreatePaymentParams) {
    const result = await this.db.db
      .insert(payment)
      .values({
        appUrn: params.appUrn,
        userId: params.userId,
        paymentMethod: params.paymentMethod,
        amount: params.amount,
        currency: params.currency,
        status: params.status,
      })
      .returning();

    return result[0];
  }

  async getPaymentById(paymentId: number) {
    const result = await this.db.db.select().from(payment).where(eq(payment.id, paymentId));

    return result[0] ?? null;
  }

  async updatePaymentStatus(paymentId: number, status: PaymentStatus, metadata?: PaymentMetadata) {
    const updateData: Record<string, unknown> = { status };

    if (metadata?.stripePaymentIntentId) {
      updateData.stripePaymentIntentId = metadata.stripePaymentIntentId;
    }
    if (metadata?.x402TransactionHash) {
      updateData.x402TransactionHash = metadata.x402TransactionHash;
    }

    await this.db.db.update(payment).set(updateData).where(eq(payment.id, paymentId));
  }

  async getPaymentsByUserId(userId: number) {
    return this.db.db.select().from(payment).where(eq(payment.userId, userId)).orderBy(desc(payment.createdAt));
  }

  async getPaymentsByAppUrn(appUrn: string) {
    return this.db.db.select().from(payment).where(eq(payment.appUrn, appUrn)).orderBy(desc(payment.createdAt));
  }

  async getPaymentsByUserAndApp(userId: number, appUrn: string) {
    return this.db.db.select().from(payment).where(and(eq(payment.userId, userId), eq(payment.appUrn, appUrn))).orderBy(desc(payment.createdAt));
  }

  async getActiveSubscription(userId: number, appUrn: string) {
    const result = await this.db.db
      .select()
      .from(subscription)
      .where(and(eq(subscription.userId, userId), eq(subscription.appUrn, appUrn), eq(subscription.status, 'active')));

    return result[0] ?? null;
  }

  async getSubscriptionById(subscriptionId: number) {
    const result = await this.db.db.select().from(subscription).where(eq(subscription.id, subscriptionId));

    return result[0] ?? null;
  }

  async cancelSubscription(subscriptionId: number) {
    await this.db.db.update(subscription).set({ status: 'cancelled', cancelledAt: new Date().toISOString() }).where(eq(subscription.id, subscriptionId));
  }

  async createSubscription(params: {
    appUrn: string;
    userId: number;
    paymentMethod: 'stripe' | 'x402';
    amount: string;
    currency: string;
    interval: 'monthly' | 'yearly';
    stripeSubscriptionId?: string;
  }) {
    const result = await this.db.db
      .insert(subscription)
      .values({
        appUrn: params.appUrn,
        userId: params.userId,
        paymentMethod: params.paymentMethod,
        amount: params.amount,
        currency: params.currency,
        interval: params.interval,
        stripeSubscriptionId: params.stripeSubscriptionId,
        status: 'active',
      })
      .returning();

    return result[0];
  }
}
