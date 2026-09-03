# Trust between Companion Hub and Companion Portal

Companion Hub uses the PolyForm Noncommercial License. **Companion Portal** and **Companion Memory** remain closed-source products. When you review Portal interactions, treat a modified Hub as an **untrusted Portal client**.

Use this page to review the trust boundaries between these products. It is not a penetration test report.

Reviewed against CI-Portal `origin/dev` @ `b5d539b8` (2026-09-03) and this Hub branch. Remaining GET-install gap: [CI-Portal#633](https://github.com/companionintelligence/CI-Portal/issues/633).

## Trust boundaries

| Boundary | Who is trusted | What it covers |
|---|---|---|
| Portal ↔ Hub device | Portal | Pairing, device API key, store install *commands*, registry JWTs, tunnels |
| Hub ↔ apps on the appliance | Hub (local) | Traefik forward-auth headers, memory-connect, wake hooks |
| Hub ↔ Memory | Shared appliance secrets | HMAC / connect signing; Memory remains closed-source |

## Device identity

1. During pairing, Portal issues a device credential that Hub stores as `ciHubApiKey`.
2. Hub sends `Authorization: Bearer <ciHubApiKey>` and `x-device-key: <ciHubApiKey>` on outbound Portal calls (`PortalClientService.getDeviceAuthHeaders()`).
3. You can set a local `DEVICE_ID` for diagnostics. **Portal must bind the device ID to the issued key.** A forked Hub cannot create another device's key.

Portal `deviceAuthMiddleware` refuses a missing or unknown `x-device-key` with `401`. `POST /api/devices/registry-token` uses that middleware and ignores caller-requested `access` / `repo` so a stolen device key cannot widen registry scope.

## Marketplace install and registry

Two different routes share the `/api/store/:id/install` path:

| Method | Caller | Auth today | Role |
|---|---|---|---|
| `POST` | Portal session (person in the store UI) | `sessionMiddleware` plus organization membership over the named device | Portal **pushes** an install command to that Hub |
| `GET` | Hub (`downloadAppFiles`) | **Not** `deviceAuthMiddleware`. Free apps return compose with no credential. Paid apps require `x-device-id` and a completed transaction, not the device key | Hub **pulls** the install bundle |

Hub already sends `x-device-key` on the GET. Portal does not require it. A modified open-source Hub can therefore fetch **free** marketplace compose without a paired key. Paid bundles still need a completed purchase for that `x-device-id`; the header is spoofable, so the real gate is the transaction row, not possession of the device key.

Until GET install is bound to `deviceAuthMiddleware` (same as registry-token), **do not describe Portal as fail-closed for catalog downloads**. Registry JWTs (`POST /api/devices/registry-token`) already fail closed.

A modified Hub can still compose and run **local or unsigned** apps. That must not unlock paid Portal artifacts, registry pulls, or other users' Portal sessions.

## Capabilities of a modified open-source Hub

| Action | Possible without stolen Portal credentials? | Notes |
|---|---|---|
| Impersonate another paired device at Portal | No, on routes that use `deviceAuthMiddleware` | Needs that device's Portal-issued key |
| Impersonate a Portal end-user (OIDC) | No | Hub verifies Portal JWTs via JWKS; forging needs Portal keys |
| Download a **free** store install bundle | Yes today | `GET /api/store/:id/install` is unauthenticated for `priceModel === 'free'` |
| Download a **paid** store install bundle | Only with a completed transaction for the claimed `x-device-id` | Header is not the device key; bind GET install to `x-device-key` |
| Skip Portal entitlement for registry pulls | No | Minted JWT is pull-only for `ci-hub`; caller `access`/`repo` ignored |
| Run arbitrary local Docker apps | Yes | Appliance control plane is local |
| Forge Traefik forward-auth identity for apps that trust Hub HMAC | Yes | Whoever controls Hub and `CI_HUB_FORWARD_AUTH_SECRET` (or the per-app secret) can mint `X-CI-Hub-User` headers. That trust is **appliance-local**, not Portal authority |

## Memory-connect and wake

- Require a Hub session for browser memory-connect (`AuthGuard`).
- Bind managed app keys to an app URN. Don't treat internal-network IP allowlists as the security boundary.
- Keep agent wake and notify operations on the appliance (Hub → app wake hooks). These operations don't grant Portal marketplace rights.

## Forward-auth is appliance-local

Traefik `forwardauth` calls Hub `/api/auth/traefik`. On a valid Hub session, Hub returns HMAC-signed `X-CI-Hub-User` headers for **apps on that appliance**. Those headers are not a Portal session and must not be treated as one. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) (forward auth) and [`adr/002-sibling-public-hostnames-edge-sso.md`](../adr/002-sibling-public-hostnames-edge-sso.md).

## Entitlements follow-up

[Issue #722](https://github.com/companionintelligence/CI-Hub/issues/722) tracks Hub-side entitlement checks before install, start, and update operations. Until those checks ship **and** GET install requires the device key, **Portal's authenticated routes** (pairing, POST install, registry-token, tunnels) are the commercial gate — not the unauthenticated GET bundle.

## Review checklist for publication

- [x] Registry-token: Portal rejects a missing or invalid `x-device-key` (`MintRegistryToken` + `deviceAuthMiddleware`; covered by Portal tests).
- [ ] GET install bundle: Portal must reject a missing or invalid `x-device-key` (today it does not). [CI-Portal#633](https://github.com/companionintelligence/CI-Portal/issues/633)
- [x] Portal does not treat Hub-reported entitlement claims as authoritative on POST install (session + membership + payment/transaction).
- [x] Forward-auth documentation states Hub-signed headers apply only to apps on that appliance (this page + architecture).
- [x] Memory and Portal remain closed-source; the Hub license does not relicense them ([License FAQ](../License-FAQ.md)).
