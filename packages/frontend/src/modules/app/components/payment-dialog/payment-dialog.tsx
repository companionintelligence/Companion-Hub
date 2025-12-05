import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { type Pricing, PricingBadge } from '@/components/pricing-badge';
import './payment-dialog.css';

interface PaymentDialogProps {
  appName: string;
  appUrn: string;
  pricing: Pricing;
  onPaymentComplete?: () => void;
  trigger: React.ReactNode;
}

export const PaymentDialog: React.FC<PaymentDialogProps> = ({ appName, appUrn, pricing, onPaymentComplete, trigger }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<'stripe' | 'x402' | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handlePayment = async () => {
    if (!selectedMethod) return;

    setIsProcessing(true);

    try {
      // In a real implementation, this would call the payment API
      // For now, we'll just simulate a payment flow
      console.log(`Processing ${selectedMethod} payment for ${appUrn}`);

      // Simulate API call
      await new Promise((resolve) => setTimeout(resolve, 1000));

      onPaymentComplete?.();
      setIsOpen(false);
    } catch (error) {
      console.error('Payment failed:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  const paymentMethods = pricing.payment_methods || [];
  const hasStripe = paymentMethods.includes('stripe');
  const hasX402 = paymentMethods.includes('x402');

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('PAYMENT_TITLE')}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          <div className="payment-dialog-content">
            <div className="payment-app-info">
              <h4>{appName}</h4>
              <div className="payment-price-display">
                <PricingBadge pricing={pricing} size="lg" />
              </div>
            </div>

            {pricing.type !== 'free' && (
              <>
                <div className="payment-methods-section">
                  <h5>{t('PAYMENT_TITLE')}</h5>
                  <div className="payment-method-options">
                    {hasStripe && (
                      <button
                        type="button"
                        className={`payment-method-option ${selectedMethod === 'stripe' ? 'selected' : ''}`}
                        onClick={() => setSelectedMethod('stripe')}
                      >
                        <span className="payment-method-icon">💳</span>
                        <span>{t('PAYMENT_METHOD_STRIPE')}</span>
                      </button>
                    )}
                    {hasX402 && (
                      <button
                        type="button"
                        className={`payment-method-option ${selectedMethod === 'x402' ? 'selected' : ''}`}
                        onClick={() => setSelectedMethod('x402')}
                      >
                        <span className="payment-method-icon">🔗</span>
                        <span>{t('PAYMENT_METHOD_X402')}</span>
                      </button>
                    )}
                  </div>
                </div>

                {selectedMethod === 'x402' && (
                  <div className="x402-info">
                    <p>{t('PAYMENT_X402_INFO')}</p>
                  </div>
                )}
              </>
            )}
          </div>
        </DialogDescription>
        <DialogFooter>
          <Button intent="ghost" onClick={() => setIsOpen(false)} disabled={isProcessing}>
            {t('APP_ACTION_CANCEL')}
          </Button>
          {pricing.type !== 'free' && (
            <Button intent="primary" onClick={handlePayment} disabled={!selectedMethod || isProcessing} loading={isProcessing}>
              {pricing.type === 'subscription' ? t('PAYMENT_SUBSCRIBE') : t('PAYMENT_PURCHASE')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
