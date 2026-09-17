# Trust between Companion Hub and Companion Portal

Companion Hub uses the PolyForm Noncommercial License. **Companion Portal** remains a closed-source product. Companion Memory is PolyForm Noncommercial in its own repository. When you review Portal interactions, treat a modified Hub as an **untrusted Portal client**.

Use this page to review the trust boundaries between these products. It is not a penetration test report.

Reviewed against CI-Portal app entitlements ([#639](https://github.com/companionintelligence/CI-Portal/pull/639)) and org grants ([#641](https://github.com/companionintelligence/CI-Portal/pull/641)), Hub entitlement cache ([#1212](https://github.com/companionintelligence/CI-Hub/pull/1212)), and Hub WhoIs ([#1214](https://github.com/companionintelligence/CI-Hub/issues/1214)). GET install device-key auth is merged in [CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634).

## Three planes

Do not merge these. A Pro organization is not entitled to every marketplace app, buying an app does not grant Pro, and an org entitlement does not mean every member may install or start that app.

| Plane | What it sells / governs | Source of truth | Stripe |
|---|---|---|---|
| **Platform** | Devices, subdomains, custom domains | `org_plan` / `org_plan_addon`, `EntitlementService` | Checkout and Billing Portal already on Portal. App Checkout **reuses** that Stripe customer and `PaymentProvider.createCheckoutSession` (including saved-card `limited` filters). It is **not** behind `billing.enforcement`. |
| **App commerce** | Marketplace install bundles and private registry images | Org-scoped `app_entitlement` | `metadata.type === 'app'` short-circuits the webhook before platform `intentFor`. 201 from Checkout is a page, not a grant. |
| **Org grants** | Which **member** may do what to which app (Tailscale-shaped ACL) | Org `organization_acl_policy` via Portal WhoIs / CapMap | None. AND with commerce. A kid without `install` gets `GRANT_DENIED`, not ASK_ADMIN. |

Hub never meters usage to Portal. Hub never decides who paid. Hub WhoIs is **not** a till.

## Trust boundaries

| Boundary | Who is trusted | What it covers |
|---|---|---|
| Portal ↔ Hub device | Portal | Pairing, device API key, store install *commands*, GET install bundles, registry JWTs, tunnels, app entitlement checks |
| Hub ↔ apps on the appliance | Hub (local) | Traefik forward-auth headers, memory-connect, wake hooks, local Docker |
| Hub ↔ Memory | Shared appliance secrets | HMAC / connect signing; Memory is PolyForm Noncommercial in CI-Server |

## Device identity

1. During pairing, Portal issues a device credential that Hub stores as `ciHubApiKey`.
2. Hub sends `Authorization: Bearer <ciHubApiKey>` and `x-device-key: <ciHubApiKey>` on outbound Portal calls (`PortalClientService.getDeviceAuthHeaders()`).
3. You can set a local `DEVICE_ID` for diagnostics. **Portal binds the device ID to the issued key.** A forked Hub cannot mint another device's key.

Portal `deviceAuthMiddleware` refuses a missing or unknown `x-device-key` with `401`. Query parameters such as `organizationId` and headers such as `x-device-id` are not identity. The org comes from **device registrations for that key**.

## Org grants (WhoIs)

Portal evaluates grants. Hub caches the CapMap for UX ([#1214](https://github.com/companionintelligence/CI-Hub/issues/1214)). Spec: [CI-Engineering org-app-grants](https://github.com/companionintelligence/CI-Engineering/blob/docs/org-app-grants/projects/org-app-grants/SPEC.md).

- **Identity:** Hub-session operator → `federated_identity.subject` (Portal user id). Device WhoIs is `POST /api/whois` with the appliance `x-device-key` plus that `subject`. Hub has no stored Portal access token and must not take `subject` from the browser.
- **Portal-push vs Hub session:** Portal-pushed installs authenticate as `Bearer ${ciHubApiKey}`. `AuthMiddleware` maps that to the first operator and does **not** set `req.hubSessionId`. Hub evaluates grants only when `hubSessionId` is set. Portal already returned `GRANT_DENIED` on POST install.
- **Unlinked operator:** no federated row → compiled member `HUB_ACTIONS` (not owner `*`) and one `whois_skipped_unlinked_operator` log per userId per process.
- **`organizationId`:** every device WhoIs names this Hub’s `device_registration.id` (the configured organization first). It selects; it is not identity. A Portal with the narrowing ([CI-Portal#734](https://github.com/companionintelligence/CI-Portal/pull/734)) honours it only for one of the device’s current organizations, answers `403 GRANT_DENIED` for any other, and needs it to settle a device whose registrations tie on pairing time (`409 ORGANIZATION_REQUIRED` otherwise). An older Portal ignores it and lists every shared organization, so Hub still picks this Hub’s `device_registration.id` from the answer; do not union.
- **Surfaces:** `hub` for installed list / lifecycle (Portal zeros `can` when not entitled). `store` for catalog search so Buy still shows.
- **Cache:** `(subject, appId) → can[]` plus ACL `version`, 24h TTL like the entitlement cache. Call Portal whenever this Hub’s organization is known; an unreadable or missing registration, like an unreachable Portal, falls back to the cache without asking. Mutating actions fail closed with no fresh cache. Lists fail open so an outage does not empty the house.
- **Hostile Hub:** skip this cache, forge `subject` within orgs the stolen device key belongs to. That is CapMap privacy, not till bypass. GET install and registry stay `app_entitlement`.

Caps header (`X-CI-Hub-Caps`) is spec phase 3, not this Hub path.

## Marketplace install and registry

Two different routes share the `/api/store/:id/install` path:

| Method | Caller | Auth | Role |
|---|---|---|---|
| `POST` | Portal session (person in the store UI) | `sessionMiddleware` plus organization membership over the named device | Portal **pushes** an install command to that Hub. Missing `install` in `can` is 403 `GRANT_DENIED` **before** ASK_ADMIN / Checkout. Owner/admin may pay; members of an unpaid org get `ASK_ADMIN`. An existing org `app_entitlement` skips payment. |
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
| Skip Hub's local WhoIs **cache** | Yes | [#1214](https://github.com/companionintelligence/CI-Hub/issues/1214) is UX. Portal POST install `GRANT_DENIED` and `app_entitlement` remain the gates |
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
- **Start / restart:** best-effort so an already-installed app can come up when Portal is down, unless a fresh cache says not entitled. Restart shares Start's policy and checks it before `down`.
- **404 / free:** skip (local or unsigned apps still run).
- **402:** `APP_INSTALL_PORTAL_DOWNLOAD_PAYMENT_REQUIRED`.
- **401:** install and update refuse with the existing unauthorized string. Start and restart use the unreachable policy, because a rejected device key is not an entitlement decision. See [`portal-check-in.md`](../portal-check-in.md#entitlement-checks-on-start-and-restart).

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
- [x] Hub WhoIs / org grants cache is documented as UX, not a till ([#1214](https://github.com/companionintelligence/CI-Hub/issues/1214)). Device WhoIs uses federated `subject`; Portal-push skips Hub grants.
- [x] Forward-auth documentation states Hub-signed headers apply only to apps on that appliance (this page + architecture).
- [x] Portal remains closed-source. Memory is PolyForm Noncommercial in CI-Server; the Hub license does not relicense Portal ([License FAQ](../License-FAQ.md)).
