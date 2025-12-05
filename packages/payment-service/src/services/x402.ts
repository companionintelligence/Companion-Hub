/**
 * X402 Payment Service
 * Implements the X402 payment protocol for cryptocurrency transactions
 * See: https://www.x402.org/
 */
export class X402Service {
  private x402Enabled: boolean;
  private x402PaymentAddress: string | undefined;

  constructor() {
    this.x402Enabled = process.env.X402_ENABLED === 'true';
    this.x402PaymentAddress = process.env.X402_PAYMENT_ADDRESS;
  }

  /**
   * Verify an X402 crypto payment transaction
   * 
   * IMPORTANT: This is a placeholder implementation.
   * In production, this must verify the transaction on the blockchain
   * before returning true. Returning true without verification would
   * allow users to bypass payment.
   */
  async verifyPayment(transactionHash: string): Promise<boolean> {
    if (!this.x402Enabled) {
      console.warn('X402 payments not enabled');
      return false;
    }

    if (!transactionHash || transactionHash.length < 10) {
      console.warn('Invalid transaction hash format');
      return false;
    }

    try {
      // In production, this would verify the transaction on the blockchain
      // using the X402 protocol specifications
      // The verification would check:
      // 1. Transaction exists on the blockchain
      // 2. Transaction is confirmed (has enough confirmations)
      // 3. Payment amount matches expected amount
      // 4. Payment was sent to the correct address

      console.log(`Verifying X402 transaction: ${transactionHash}`);

      // SECURITY: Throw error to prevent unauthorized access
      // This placeholder must be replaced with actual blockchain verification
      throw new Error('X402 payment verification not implemented. Blockchain integration required.');
    } catch (error) {
      console.error('Failed to verify X402 payment:', error);
      return false;
    }
  }

  /**
   * Generate X402 payment request
   * Returns the payment details needed for the client to initiate payment
   */
  async createPaymentRequest(params: {
    amount: number;
    currency: string;
    appUrn: string;
    userId: number;
  }) {
    if (!this.x402Enabled || !this.x402PaymentAddress) {
      throw new Error('X402 payments not enabled or payment address not configured');
    }

    const paymentId = `x402_${Date.now()}_${params.userId}`;

    // The X402 protocol defines a standard format for payment requests
    // that includes the payment address, amount, and metadata
    const paymentRequest = {
      id: paymentId,
      protocol: 'x402',
      version: '1.0',
      paymentAddress: this.x402PaymentAddress,
      amount: params.amount,
      currency: params.currency,
      metadata: {
        appUrn: params.appUrn,
        userId: params.userId,
      },
      // X402 uses HTTP 402 Payment Required status code semantics
      // The payment request can be embedded in HTTP headers
      httpHeaders: {
        'X-Payment-Address': this.x402PaymentAddress,
        'X-Payment-Amount': String(params.amount),
        'X-Payment-Currency': params.currency,
        'X-Payment-Id': paymentId,
      },
    };

    console.log(`Created X402 payment request for ${params.appUrn}`);

    return paymentRequest;
  }

  /**
   * Get supported cryptocurrencies for X402 payments
   */
  getSupportedCurrencies() {
    return [
      { symbol: 'BTC', name: 'Bitcoin', enabled: true },
      { symbol: 'ETH', name: 'Ethereum', enabled: true },
      { symbol: 'USDC', name: 'USD Coin', enabled: true },
      { symbol: 'USDT', name: 'Tether', enabled: true },
    ];
  }

  /**
   * Check if X402 payments are enabled
   */
  isEnabled(): boolean {
    return this.x402Enabled && Boolean(this.x402PaymentAddress);
  }
}
