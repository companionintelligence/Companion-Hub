import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import type { CreatePaymentDto, ProcessStripePaymentDto, ProcessX402PaymentDto } from './dto/payments.dto';
import type { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: number };
}

@ApiTags('Payments')
@Controller('payments')
@UseGuards(AuthGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new payment' })
  @ApiResponse({ status: 201, description: 'Payment created successfully' })
  async createPayment(@Body() createPaymentDto: CreatePaymentDto, @Req() req: AuthenticatedRequest) {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('User not authenticated');
    }
    return this.paymentsService.createPayment({
      ...createPaymentDto,
      userId,
    });
  }

  @Post(':id/stripe/process')
  @ApiOperation({ summary: 'Process a Stripe payment' })
  @ApiResponse({ status: 200, description: 'Payment processed' })
  async processStripePayment(@Param('id') paymentId: number, @Body() dto: ProcessStripePaymentDto) {
    return this.paymentsService.processStripePayment(paymentId, dto.stripePaymentIntentId);
  }

  @Post(':id/x402/process')
  @ApiOperation({ summary: 'Process an X402 crypto payment' })
  @ApiResponse({ status: 200, description: 'Payment processed' })
  async processX402Payment(@Param('id') paymentId: number, @Body() dto: ProcessX402PaymentDto) {
    return this.paymentsService.processX402Payment(paymentId, dto.transactionHash);
  }

  @Get('user')
  @ApiOperation({ summary: 'Get current user payment history' })
  @ApiResponse({ status: 200, description: 'Returns payment history' })
  async getUserPayments(@Req() req: AuthenticatedRequest) {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('User not authenticated');
    }
    return this.paymentsService.getUserPayments(userId);
  }

  @Get('app/:appUrn')
  @ApiOperation({ summary: 'Get payment history for an app' })
  @ApiResponse({ status: 200, description: 'Returns payment history' })
  async getAppPayments(@Param('appUrn') appUrn: string) {
    return this.paymentsService.getAppPayments(appUrn);
  }

  @Get('check/:appUrn')
  @ApiOperation({ summary: 'Check if user has paid for an app' })
  @ApiResponse({ status: 200, description: 'Returns payment status' })
  async checkPaymentStatus(@Param('appUrn') appUrn: string, @Req() req: AuthenticatedRequest) {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('User not authenticated');
    }
    const hasPaid = await this.paymentsService.hasUserPaidForApp(userId, appUrn);
    const activeSubscription = await this.paymentsService.getActiveSubscription(userId, appUrn);
    return { hasPaid, activeSubscription };
  }

  @Post('subscriptions/:id/cancel')
  @ApiOperation({ summary: 'Cancel a subscription' })
  @ApiResponse({ status: 200, description: 'Subscription cancelled' })
  async cancelSubscription(@Param('id') subscriptionId: number) {
    return this.paymentsService.cancelSubscription(subscriptionId);
  }
}
