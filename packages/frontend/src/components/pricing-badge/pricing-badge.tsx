import type React from 'react';
import { useTranslation } from 'react-i18next';
import './pricing-badge.css';

export interface Pricing {
  type: 'free' | 'one_time' | 'subscription';
  price?: number;
  currency?: string;
  interval?: 'monthly' | 'yearly';
  payment_methods?: Array<'stripe' | 'x402'>;
}

interface PricingBadgeProps {
  pricing?: Pricing;
  showPaymentMethods?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const formatPrice = (price: number, currency: string): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: price % 1 === 0 ? 0 : 2,
  }).format(price);
};

export const PricingBadge: React.FC<PricingBadgeProps> = ({ pricing, showPaymentMethods = false, size = 'md' }) => {
  const { t } = useTranslation();

  // Default to free if no pricing defined
  if (!pricing || pricing.type === 'free') {
    return (
      <span className={`pricing-badge pricing-badge-${size} pricing-badge-free`}>
        {t('PAYMENT_FREE')}
      </span>
    );
  }

  const { type, price, currency = 'USD', interval } = pricing;

  if (type === 'one_time' && price) {
    return (
      <div className="pricing-container">
        <span className={`pricing-badge pricing-badge-${size} pricing-badge-paid`}>
          {formatPrice(price, currency)}
        </span>
        {showPaymentMethods && pricing.payment_methods && (
          <div className="payment-methods">
            {pricing.payment_methods.map((method) => (
              <span key={method} className="payment-method-icon" title={method === 'stripe' ? t('PAYMENT_METHOD_STRIPE') : t('PAYMENT_METHOD_X402')}>
                {method === 'stripe' ? '💳' : '🔗'}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (type === 'subscription' && price && interval) {
    const intervalLabel = interval === 'monthly' ? t('PAYMENT_MONTHLY') : t('PAYMENT_YEARLY');
    return (
      <div className="pricing-container">
        <span className={`pricing-badge pricing-badge-${size} pricing-badge-subscription`}>
          {formatPrice(price, currency)}/{intervalLabel.toLowerCase()}
        </span>
        {showPaymentMethods && pricing.payment_methods && (
          <div className="payment-methods">
            {pricing.payment_methods.map((method) => (
              <span key={method} className="payment-method-icon" title={method === 'stripe' ? t('PAYMENT_METHOD_STRIPE') : t('PAYMENT_METHOD_X402')}>
                {method === 'stripe' ? '💳' : '🔗'}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return null;
};
