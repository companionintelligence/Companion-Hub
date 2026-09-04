# Trust between Companion Hub and Companion Portal

Companion Hub uses the PolyForm Noncommercial License. **Companion Portal** and **Companion Memory** remain closed-source products. When you review Portal interactions, treat a modified Hub as an **untrusted Portal client**.

Use this page to review the trust boundaries between these products. It is not a penetration test report.

Reviewed against CI-Portal `feat/app-entitlements` ([#639](https://github.com/companionintelligence/CI-Portal/pull/639)) and this Hub branch ([#1212](https://github.com/companionintelligence/CI-Hub/pull/1212)). GET install device-key auth is merged in [CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634).

## Two planes

Do not merge these. A Pro organization is not entitled to every marketplace app, and buying an app does not grant Pro.

| Plane | What it sells | Source of truth | Stripe |
|---|---|---|---|
| **Platform** | Devices, subdomains, custom domains | `org_plan` / `org_plan_addon`, `EntitlementService` | Checkout and Billing Portal already on Portal. App Checkout **reuses** that Stripe customer and `PaymentProvider.createCheckoutSession` (including saved-card `limited` filters). It is **not** behind `billing.enforcement`. |
| **App** | Marketplace install bundles and private registry images | Org-scoped `app_entitlement` | `metadata.type === 'app'` short-circuits the webhook before platform `intentFor`. 201 from Checkout is a page, not a grant. |

Hub never meters usage to Portal. Hub never decides who paid.

## Trust boundaries

| Boundary | Who is trusted | What it covers |
|---|---|---|
| Portal ↔ Hub device | Portal | Pairing, device API key, store install *commands*, GET install bundles, registry JWTs, tunnels, app entitlement checks |
| Hub ↔ apps on the appliance | Hub (local) | Traefik forward-auth headers, memory-connect, wake hooks, local Docker |
| Hub ↔ Memory | Shared appliance secrets | HMAC / connect signing; Memory remains closed-source |

## Device identity

1. During pairing, Portal issues a device credential that Hub stores as `ciHubApiKey`.
2. Hub sends `Authorization: Bearer <ciHubApiKey>` and `x-device-key: <ciHubApiKey>` on outbound Portal calls (`PortalClientService.getDeviceAuthHeaders()`).
3. You can set a local `DEVICE_ID` for diagnostics. **Portal binds the device ID to the issued key.** A forked Hub cannot mint another device's key.

Portal `deviceAuthMiddleware` refuses a missing or unknown `x-device-key` with `401`. Query parameters such as `organizationId` and headers such as `x-device-id` are not identity. The org comes from **device registrations for that key**.

## Marketplace install and registry

Two different routes share the `/api/store/:id/install` path:

| Method | Caller | Auth | Role |
|---|---|---|---|
| `POST` | Portal session (person in the store UI) | `sessionMiddleware` plus organization membership over the named device | Portal **pushes** an install command to that Hub. Owner/admin may pay; members of an unpaid org get `ASK_ADMIN`. An existing org `app_entitlement` skips payment. |
| `GET` | Hub (`downloadAppFiles`) | `deviceAuthMiddleware` (`x-device-key`) — [CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634) | Hub **pulls** the install bundle. Free apps (`priceModel === 'free'` only) succeed for a paired device. Paid apps need an **active org entitlement** for an org that device is registered to — not a device-scoped `store_transaction`. |

`GET /api/entitlements/check?appId=` is the same device-key till, used by Hub's local cache. It is not a Hub-trusted claim: Portal re-checks on GET install and on registry mint.

### Registry tokens

`POST /api/devices/registry-token` uses `deviceAuthMiddleware` and **ignores** caller-requested `access` / `repo`.

| Body | JWT |
|---|---|
| none | Pull-only for `ci-hub` (Hub stack listing) |
| `{ appId }` | Pull-only `repos[]` from that app's compose, after an org entitlement check |

Registry `/v2` accepts `payload.repos` (array) or legacy `payload.repo` (string). Tokens without write scope cannot PUT. Repos with a `docker/<repo>/public` marker are readable **without** a JWT. Portal refuses to write those markers for any app whose `priceModel` is not `free` (`PAID_APP_NOT_PUBLIC`).

### If this machine cannot pair

Hub still attempts those Portal calls. Without a stored device key, Portal returns `401`. Marketplace installs do not finish. Registry listing falls back to an empty tag list (`RegistryService.getDeviceRegistryToken`), so the catalog can look **slow or empty** rather than obviously unauthorized. Complete pairing (`cihub register` or the onboarding UI) before you expect store installs to work.

## Capabilities of a modified open-source Hub

Assume the operator controls the appliance: they can patch Hub, skip local checks, and run Docker as they like. They do **not** have Portal signing keys, Stripe webhook secrets, or another customer's `x-device-key`.

| Action | Possible without stolen Portal credentials? | Notes |
|---|---|---|
| Impersonate another paired device at Portal | No | Needs that device's Portal-issued key |
| Impersonate a Portal end-user (OIDC) | No | Hub verifies Portal JWTs via JWKS |
| Download a **free** store install bundle | No | Needs a Portal-issued device key ([#634](https://github.com/companionintelligence/CI-Portal/pull/634)) |
| Download a **paid** store install bundle | No | Key plus an active `app_entitlement` on an org that device is registered to. Client `organizationId` is ignored |
| Skip Hub's local entitlement **cache** | Yes | [Issue #722](https://github.com/companionintelligence/CI-Hub/issues/722) / [#1212](https://github.com/companionintelligence/CI-Hub/pull/1212) is UX. Portal GET install and `/v2` remain the till |
| Widen a registry JWT | No | Mint ignores client `access`/`repo`; Hub-stack token is `ci-hub` only; app tokens are `repos[]` after entitlement |
| Pull a **public-marked** image with no JWT | Yes, if a marker exists | Portal must not mark paid repos public. A mis-marked paid repo is pullable by any Hub |
| Pull a **private** paid image | No, without an entitled JWT | Hub does not yet `docker login` with the per-app JWT, so an **entitled** private pull may still fail at compose — a product gap, not a fail-open |
| Open app Checkout or grant `app_entitlement` | No | Session + owner/admin; webhook HMAC; Hub is not on that path |
| Forge Stripe webhooks | No | Portal verifies Stripe signatures |
| Bill from Hub-reported metering | No | Not implemented, and must not be |
| Run arbitrary local Docker apps | Yes | Appliance control plane is local. Unsigned compose is not a Portal entitlement |
| Forge Traefik forward-auth identity for apps on this appliance | Yes | Whoever controls Hub and `CI_HUB_FORWARD_AUTH_SECRET` (or the per-app secret) can mint `X-CI-Hub-User`. That trust is **appliance-local**, not Portal authority |

## Hub cache (#722 / #1212)

`MarketplaceEntitlementService` caches Portal `/api/entitlements/check` for 24h.

- **Install / update:** fail closed if Portal is unreachable and there is no fresh entitled cache.
- **Start:** best-effort so an already-installed app can come up when Portal is down, unless a fresh cache says not entitled.
- **404 / free:** skip (local or unsigned apps still run).
- **402:** `APP_INSTALL_PORTAL_DOWNLOAD_PAYMENT_REQUIRED`.
- **401:** existing unauthorized string.

Skipping or forging this cache cannot download a paid bundle or mint an app registry JWT.

## Memory-connect and wake

- Require a Hub session for browser memory-connect (`AuthGuard`).
- Bind managed app keys to an app URN. Don't treat internal-network IP allowlists as the security boundary.
- Keep agent wake and notify operations on the appliance (Hub → app wake hooks). These operations don't grant Portal marketplace rights.

## Forward-auth is appliance-local

Traefik `forwardauth` calls Hub `/api/auth/traefik`. On a valid Hub session, Hub returns HMAC-signed `X-CI-Hub-User` headers for **apps on that appliance**. Those headers are not a Portal session and must not be treated as one. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) (forward auth) and [`adr/002-sibling-public-hostnames-edge-sso.md`](../adr/002-sibling-public-hostnames-edge-sso.md).

## Review checklist for publication

- [x] Registry-token: Portal rejects a missing or invalid `x-device-key` (`MintRegistryToken` + `deviceAuthMiddleware`; covered by Portal tests).
- [x] GET install bundle: Portal rejects a missing or invalid `x-device-key` ([CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634), merged).
- [x] Paid GET install is an **org** `app_entitlement`, not a device `store_transaction`. Query `organizationId` is not identity ([CI-Portal#639](https://github.com/companionintelligence/CI-Portal/pull/639)).
- [x] Portal does not treat Hub-reported entitlement claims as authoritative on POST install (session + membership + entitlement/payment).
- [x] Paid apps cannot receive `docker/<repo>/public` markers (`PAID_APP_NOT_PUBLIC` on publish and visibility).
- [x] App Checkout reuses the org's platform Stripe customer and the same `PaymentProvider` Checkout snippet as custom domains / Pro. Planes stay separate (`metadata.type === 'app'`).
- [x] Hub entitlement cache is documented as UX, not a till ([#1212](https://github.com/companionintelligence/CI-Hub/pull/1212)).
- [x] Forward-auth documentation states Hub-signed headers apply only to apps on that appliance (this page + architecture).
- [x] Memory and Portal remain closed-source; the Hub license does not relicense them ([License FAQ](../License-FAQ.md)).
