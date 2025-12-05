import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Payments Module
 * 
 * This module acts as a client to the isolated payment service.
 * The actual payment processing (Stripe, X402) happens in the separate
 * payment-service container at payment.${DOMAIN}.
 * 
 * This architecture provides:
 * - Secret key isolation (Stripe/X402 keys only in payment service)
 * - Separate SQLite database for payment data
 * - Minimal attack surface for payment processing
 */
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
