# App Store Payment Integration Guide

This document describes how to add payment support to app store listings in CI-OS-Hub.

## Architecture Overview

CI-OS-Hub uses a **fully isolated payment architecture** where the payment service runs in a separate Docker container and serves as the **source of truth** for:

- **User accounts and authentication** (OAuth 2.0 server)
- **Payments and subscriptions**
- **App entitlements and access control**
- **App store catalog** (proxied from private GitHub repository)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Browser                                    │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                ┌──────────────────┴──────────────────┐
                │                                     │
                ▼                                     ▼
┌─────────────────────────────────┐   ┌─────────────────────────────────────┐
│      Main Application           │   │        Payment Service               │
│      (your-domain.com)          │   │        (payment.your-domain.com)     │
│                                 │   │                                      │
│  ┌───────────────────────────┐  │   │  ┌────────────────────────────────┐ │
│  │    packages/backend/      │──┼───┼─▶│   packages/payment-service/    │ │
│  │                           │  │   │  │                                │ │
│  │  - App Store UI Proxy     │  │   │  │  SOURCE OF TRUTH FOR:          │ │
│  │  - OAuth Client           │  │   │  │  - User Accounts (SQLite)      │ │
│  │  - App Runtime            │  │   │  │  - Payments & Subscriptions    │ │
│  └───────────────────────────┘  │   │  │  - App Entitlements            │ │
│                                 │   │  │  - OAuth 2.0 Sessions          │ │
│  ┌───────────────────────────┐  │   │  │                                │ │
│  │    packages/frontend/     │  │   │  │  INTEGRATIONS:                 │ │
│  │                           │  │   │  │  - Stripe API                  │ │
│  │  - PricingBadge           │  │   │  │  - X402 Crypto Protocol        │ │
│  │  - PaymentDialog          │  │   │  │  - GitHub Private Repo (Apps)  │ │
│  │  - OAuth Login Flow       │  │   │  │                                │ │
│  └───────────────────────────┘  │   │  │  SECURITY:                     │ │
│                                 │   │  │  - Secret Key Isolation        │ │
└─────────────────────────────────┘   │  │  - Rate Limiting               │ │
                                      │  │  - PKCE for OAuth              │ │
         ┌────────────────────────────┤  └────────────────────────────────┘ │
         │                            │                                      │
         │                            │  ┌────────────────────────────────┐ │
         │     OAuth 2.0 Flow         │  │  Private GitHub Repository     │ │
         │  (Authorization Code +     │  │  companionintelligence/        │ │
         │   PKCE)                    │  │       CI-App-Store             │ │
         │                            │  │                                │ │
         └────────────────────────────┤  │  - App docker-compose.json     │ │
                                      │  │  - App config.json (pricing)   │ │
                                      │  │  - App assets                  │ │
                                      │  └────────────────────────────────┘ │
                                      └──────────────────────────────────────┘
```

### Data Flow

1. **User Authentication**: Users log in via the Payment Service's OAuth 2.0 server
2. **App Discovery**: Main app proxies app store catalog from Payment Service
3. **Payment**: Payment Service handles Stripe/X402 transactions
4. **Entitlement**: Payment Service grants app access upon successful payment
5. **App Download**: Payment Service provides docker-compose + payment key for verified users

### Security Benefits

| Feature | Description |
|---------|-------------|
| **Central Auth** | Single source of truth for user accounts and sessions |
| **Secret Key Isolation** | Stripe, X402, and GitHub keys stored only in payment service |
| **OAuth 2.0 + PKCE** | Secure authorization code flow with proof key for code exchange |
| **Separate Database** | SQLite database isolated from main PostgreSQL |
| **App Catalog DRM** | Paid apps require valid payment key to download |
| **Rate Limiting** | All endpoints are rate-limited to prevent abuse |

## Account Management & OAuth

### OAuth 2.0 Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /oauth/authorize` | Authorization endpoint (with PKCE support) |
| `POST /oauth/token` | Token endpoint |
| `POST /oauth/revoke` | Token revocation |
| `POST /oauth/introspect` | Token introspection |
| `GET /oauth/userinfo` | OpenID Connect userinfo |
| `GET /.well-known/openid-configuration` | OpenID Connect discovery |

### Account Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/account/register` | Create new account |
| POST | `/api/account/login` | Login with email/password |
| POST | `/api/account/logout` | Logout current session |
| GET | `/api/account/me` | Get current user profile |
| PATCH | `/api/account/me` | Update user profile |
| POST | `/api/account/me/password` | Change password |
| GET | `/api/account/me/entitlements` | Get user's app entitlements |
| GET | `/api/account/me/entitlements/:appUrn` | Check specific app access |
| DELETE | `/api/account/me` | Delete account |
| POST | `/api/account/me/logout-all` | Logout all devices |

### Registering an OAuth Client

To connect your CI-OS-Hub instance to the Payment Service:

```bash
curl -X POST https://payment.yourdomain.com/oauth/clients \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CI-OS-Hub Main App",
    "redirect_uris": ["https://yourdomain.com/oauth/callback"],
    "scopes": ["read", "write", "profile", "email"]
  }'
```

Response:
```json
{
  "client_id": "abc123...",
  "client_secret": "xyz789...",
  "message": "Store the client_secret securely. It cannot be retrieved again."
}
```

## App Store Proxy

The Payment Service acts as a secure proxy to the private GitHub app store repository.

### App Store Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/store/apps` | List all available apps |
| GET | `/api/store/apps/:appUrn/config` | Get app config (pricing visible to all) |
| GET | `/api/store/apps/:appUrn/access/:userId` | Check user's access to app |
| GET | `/api/store/apps/:appUrn/docker-compose` | Get docker-compose (requires payment) |
| POST | `/api/store/verify-key` | Verify a payment key |
| GET | `/api/store/status` | Check app store service status |

### Payment Key System

When a user pays for an app:

1. Payment Service records the payment in SQLite
2. Grants entitlement to the user for that app
3. Generates a time-limited payment key (24 hours)
4. Returns payment key with docker-compose file

The payment key can be verified by the main app to confirm access.

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

Add a `pricing` field to your app's `config.json` file in the CI-App-Store repository:

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

### Payment Service (packages/payment-service/.env)

```bash
# Server Configuration
PORT=3001
NODE_ENV=production

# Payment Service Domain (OAuth issuer)
PAYMENT_SERVICE_URL=https://payment.yourdomain.com

# Stripe Configuration
STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxxxxxxx
STRIPE_PUBLISHABLE_KEY=pk_live_xxxxxxxxxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxx

# X402 Crypto Payment Configuration
X402_ENABLED=true
X402_PAYMENT_ADDRESS=0x1234567890abcdef...

# Service-to-Service API Key
API_SECRET_KEY=your-random-secret-key-here

# Admin API Key (for registering OAuth clients)
ADMIN_API_KEY=your-admin-secret-key-here

# Database (source of truth)
DATABASE_PATH=/data/payments.db

# CORS
CORS_ORIGINS=https://yourdomain.com

# GitHub App Store Integration
GITHUB_APP_STORE_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxx
GITHUB_APP_STORE_REPO=companionintelligence/CI-App-Store
GITHUB_APP_STORE_BRANCH=main

# Payment Key Signing Secret
PAYMENT_KEY_SECRET=your-random-payment-key-secret
```

### Main Application (.env)

```bash
# Payment Service OAuth Connection
PAYMENT_SERVICE_URL=https://payment.yourdomain.com
OAUTH_CLIENT_ID=your-oauth-client-id
OAUTH_CLIENT_SECRET=your-oauth-client-secret
OAUTH_REDIRECT_URI=https://yourdomain.com/oauth/callback

# Payment Service API Key (for service-to-service calls)
PAYMENT_API_KEY=your-api-key-here
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

## Payment Service API Reference

### Payment Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/payments` | Create a new payment |
| POST | `/api/payments/:id/stripe/process` | Process Stripe payment |
| POST | `/api/payments/:id/x402/process` | Process X402 payment |
| GET | `/api/payments/user/:userId` | Get user's payment history |
| GET | `/api/payments/app/:appUrn` | Get all payments for an app |
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

## Security Considerations & DRM

### Additional Security Measures to Consider

1. **Payment Key Rotation**: Payment keys expire after 24 hours
2. **Rate Limiting**: All endpoints are rate-limited
3. **Webhook Signature Verification**: Stripe webhooks are cryptographically verified
4. **Token Cleanup**: Expired OAuth tokens are automatically cleaned up
5. **PKCE for OAuth**: Prevents authorization code interception attacks

### DRM Enforcement

- Apps are hosted in a private GitHub repository
- Docker-compose files are only provided after payment verification
- Payment keys are time-limited and user/app specific
- Entitlements are tracked in the SQLite database
- Subscription expiration is checked in real-time

### Recommended Additional Security

1. **IP-based restrictions** for payment key usage
2. **Device fingerprinting** for paid app installations
3. **License file injection** into docker-compose for app-level verification
4. **Periodic entitlement verification** for long-running apps
5. **Audit logging** for all payment and access events

## Best Practices

1. **Test Mode**: Always test with Stripe test keys before going live
2. **Webhook Security**: Verify Stripe webhook signatures
3. **Price Validation**: Validate prices server-side before processing
4. **Refund Policy**: Clearly communicate refund policies in your app description
5. **Currency**: Use consistent ISO 4217 currency codes
6. **Subscriptions**: Handle subscription lifecycle events (cancellation, expiration)
7. **OAuth Security**: Always use PKCE in the authorization code flow
8. **Session Management**: Implement proper session timeout and logout

## Troubleshooting

### Payment Service Not Starting
- Check environment variables are set correctly
- Verify SQLite database path is writable
- Check Docker logs: `docker logs runtipi-payment`

### OAuth Login Failing
- Verify OAuth client credentials are correct
- Check redirect URI matches exactly (including trailing slashes)
- Review CORS origins configuration

### App Store Not Loading
- Check GitHub token has read access to the repository
- Verify repository name and branch are correct
- Check GitHub API rate limits

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
