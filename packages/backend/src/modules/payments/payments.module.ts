import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsRepository } from './payments.repository';
import { StripeService } from './stripe.service';
import { X402Service } from './x402.service';
import { ConfigurationService } from '@/core/config/configuration.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentsRepository, StripeService, X402Service, ConfigurationService],
  exports: [PaymentsService, PaymentsRepository],
})
export class PaymentsModule {}
