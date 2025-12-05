# App Store Payment Integration Guide

This document describes how to add payment support to app store listings in CI-OS-Hub.

## Architecture Overview

CI-OS-Hub uses a **fully isolated payment architecture** where the payment service runs in a separate Docker container from the main application:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           User Browser                                   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
              ▼                                     ▼
┌───────────────────────────────┐   ┌───────────────────────────────────┐
│     Main Application          │   │      Payment Service               │
│     (your-domain.com)         │   │      (payment.your-domain.com)     │
│                               │   │                                    │
│  ┌─────────────────────────┐  │   │  ┌──────────────────────────────┐ │
│  │   packages/backend/     │──┼───┼─▶│  packages/payment-service/   │ │
│  │                         │  │   │  │                              │ │
│  │  - App Store UI         │  │   │  │  - Stripe API Integration    │ │
│  │  - User Authentication  │  │   │  │  - X402 Crypto Protocol      │ │
│  │  - App Management       │  │   │  │  - SQLite Payment Database   │ │
│  │  - PostgreSQL Database  │  │   │  │  - Secret Key Storage        │ │
│  └─────────────────────────┘  │   │  │  - Rate Limiting             │ │
│                               │   │  │  - Webhook Handlers          │ │
│  ┌─────────────────────────┐  │   │  └──────────────────────────────┘ │
│  │   packages/frontend/    │  │   │                                    │
│  │                         │  │   │  Environment Variables:            │
│  │  - PricingBadge         │  │   │  - STRIPE_SECRET_KEY              │
│  │  - PaymentDialog        │  │   │  - STRIPE_PUBLISHABLE_KEY         │
│  │  - Store Tiles          │  │   │  - STRIPE_WEBHOOK_SECRET          │
│  └─────────────────────────┘  │   │  - X402_ENABLED                   │
│                               │   │  - X402_PAYMENT_ADDRESS           │
└───────────────────────────────┘   └───────────────────────────────────┘
        │                                         │
        │  PAYMENT_SERVICE_URL                    │
        │  PAYMENT_API_KEY                        │
        └─────────────────────────────────────────┘
```

### Security Benefits

| Feature | Description |
|---------|-------------|
| **Secret Key Isolation** | Stripe and X402 API keys are stored only in the payment service container |
| **Separate Database** | Payment data stored in isolated SQLite database, separate from main PostgreSQL |
| **Minimal Attack Surface** | Payment service has minimal dependencies and limited exposed endpoints |
| **Service-to-Service Auth** | Main app authenticates with payment service using API secret key |
| **Rate Limiting** | All payment endpoints are rate-limited to prevent abuse |

## Pricing Types

CI-OS-Hub supports three types of app pricing:

| Type | Description | Use Case |
|------|-------------|----------|
| `free` | No payment required (default) | Open source apps, trials |
| `one_time` | Single purchase for lifetime access | Premium apps, tools |
| `subscription` | Recurring payments (monthly/yearly) | SaaS apps, services |

## Supported Payment Methods

1. **Stripe** - Credit/debit card payments via [Stripe](https://stripe.com)
2. **X402** - Cryptocurrency payments following the [X402 protocol](https://www.x402.org/)

## Adding Pricing to Your App

### Step 1: Update Your App's config.json

Add a `pricing` field to your app's `config.json` file:

#### Free App (Default)

```json
{
  "id": "my-app",
  "name": "My Free App",
  "version": "1.0.0",
  "pricing": {
    "type": "free"
  }
}
```

Or simply omit the `pricing` field entirely - apps are free by default.

#### One-Time Payment

```json
{
  "id": "my-premium-app",
  "name": "My Premium App",
  "version": "1.0.0",
  "pricing": {
    "type": "one_time",
    "price": 9.99,
    "currency": "USD",
    "payment_methods": ["stripe", "x402"],
    "stripe_price_id": "price_1234567890"
  }
}
```

#### Monthly Subscription

```json
{
  "id": "my-saas-app",
  "name": "My SaaS App",
  "version": "1.0.0",
  "pricing": {
    "type": "subscription",
    "price": 4.99,
    "currency": "USD",
    "interval": "monthly",
    "payment_methods": ["stripe"],
    "stripe_price_id": "price_monthly_1234567890"
  }
}
```

#### Yearly Subscription

```json
{
  "id": "my-saas-app",
  "name": "My SaaS App",
  "version": "1.0.0",
  "pricing": {
    "type": "subscription",
    "price": 49.99,
    "currency": "USD",
    "interval": "yearly",
    "payment_methods": ["stripe", "x402"],
    "stripe_price_id": "price_yearly_1234567890"
  }
}
```

## Pricing Schema Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"free"` \| `"one_time"` \| `"subscription"` | No | Pricing type. Defaults to `"free"` |
| `price` | `number` | For paid apps | Price amount (e.g., 9.99) |
| `currency` | `string` | No | ISO 4217 currency code. Defaults to `"USD"` |
| `interval` | `"monthly"` \| `"yearly"` | For subscriptions | Billing interval |
| `payment_methods` | `array` | No | Accepted payment methods: `["stripe", "x402"]`. Defaults to `["stripe"]` |
| `stripe_price_id` | `string` | For Stripe payments | Your Stripe Price ID from the Stripe Dashboard |
| `x402_resource` | `string` | For X402 payments | X402 resource identifier |

## Server Configuration

### Main Application (.env)

```bash
# Payment Service Connection
PAYMENT_SERVICE_URL=http://runtipi-payment:3001
PAYMENT_API_KEY=your-api-key-here
```

### Payment Service (packages/payment-service/.env)

```bash
# Server Configuration
PORT=3001
NODE_ENV=production

# Payment Service Domain
PAYMENT_SERVICE_URL=https://payment.yourdomain.com

# Stripe Configuration
STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxxxxxxx
STRIPE_PUBLISHABLE_KEY=pk_live_xxxxxxxxxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxx

# X402 Crypto Payment Configuration
X402_ENABLED=true
X402_PAYMENT_ADDRESS=0x1234567890abcdef...

# API Authentication (shared with main app)
API_SECRET_KEY=your-random-secret-key-here

# Database
DATABASE_PATH=/data/payments.db

# CORS
CORS_ORIGINS=https://yourdomain.com
```

## Docker Deployment

### docker-compose.yml

```yaml
services:
  runtipi-payment:
    build:
      context: ./packages/payment-service
      dockerfile: Dockerfile
    container_name: runtipi-payment
    restart: unless-stopped
    volumes:
      - payment-data:/data
    environment:
      NODE_ENV: production
      PORT: 3001
      DATABASE_PATH: /data/payments.db
    env_file:
      - ./packages/payment-service/.env
    labels:
      traefik.enable: true
      traefik.http.routers.payment-secure.rule: Host(`payment.${DOMAIN}`)
      traefik.http.routers.payment-secure.tls.certresolver: myresolver

volumes:
  payment-data:
```

### DNS Configuration

Add a DNS A record for `payment.yourdomain.com` pointing to your server.

## Setting Up Stripe

1. Create a Stripe account at [stripe.com](https://stripe.com)
2. Get your API keys from the Stripe Dashboard
3. Create a Product and Price in Stripe Dashboard
4. Copy the Price ID (starts with `price_`) to your app's config.json
5. Configure the webhook endpoint: `https://payment.yourdomain.com/api/webhooks/stripe`

### Required Stripe Webhook Events

Configure these events in your Stripe webhook:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `charge.refunded`

## Setting Up X402 Crypto Payments

1. Review the X402 protocol at [x402.org](https://www.x402.org/)
2. Set up a cryptocurrency wallet for receiving payments
3. Configure `X402_ENABLED=true` and `X402_PAYMENT_ADDRESS` in your environment

### Supported Cryptocurrencies

- Bitcoin (BTC)
- Ethereum (ETH)
- USD Coin (USDC)
- Tether (USDT)

## Payment Service API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/payments` | Create a new payment |
| POST | `/api/payments/:id/stripe/process` | Process Stripe payment |
| POST | `/api/payments/:id/x402/process` | Process X402 payment |
| GET | `/api/payments/user/:userId` | Get user's payment history |
| GET | `/api/payments/check/:appUrn/:userId` | Check payment status |
| POST | `/api/payments/subscriptions/:id/cancel` | Cancel subscription |
| POST | `/api/payments/stripe/checkout` | Create Stripe checkout session |
| POST | `/api/payments/stripe/payment-intent` | Create Stripe payment intent |
| POST | `/api/payments/x402/payment-request` | Create X402 payment request |
| GET | `/api/payments/x402/currencies` | Get supported cryptocurrencies |
| GET | `/api/payments/x402/status` | Check X402 enabled status |
| POST | `/api/webhooks/stripe` | Stripe webhook handler |

## Frontend Components

The CI-OS-Hub frontend includes built-in components for payment:

### PricingBadge Component

Displays pricing information on app tiles:
- "Free" badge for free apps
- Price badge for one-time payments
- Subscription badge with interval for subscriptions

### PaymentDialog Component

Handles the payment flow:
1. Shows available payment methods (Stripe/X402)
2. Redirects to Stripe checkout or displays X402 payment info
3. Handles payment confirmation

## Best Practices

1. **Test Mode**: Always test with Stripe test keys before going live
2. **Webhook Security**: Verify Stripe webhook signatures
3. **Price Validation**: Validate prices server-side before processing
4. **Refund Policy**: Clearly communicate refund policies in your app description
5. **Currency**: Use consistent ISO 4217 currency codes
6. **Subscriptions**: Handle subscription lifecycle events (cancellation, expiration)

## Troubleshooting

### Payment Service Not Starting
- Check environment variables are set correctly
- Verify SQLite database path is writable
- Check Docker logs: `docker logs runtipi-payment`

### Stripe Payments Failing
- Verify Stripe API keys are correct
- Check webhook configuration
- Review Stripe Dashboard for error details

### X402 Payments Not Working
- Ensure `X402_ENABLED=true` is set
- Verify `X402_PAYMENT_ADDRESS` is valid
- Check blockchain for transaction confirmation

### Service-to-Service Communication Failing
- Verify `PAYMENT_API_KEY` matches `API_SECRET_KEY` between services
- Check `PAYMENT_SERVICE_URL` is correct
- Ensure payment service container is running and accessible
