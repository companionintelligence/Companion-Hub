# Trust between Companion Hub and Companion Portal

Companion Hub uses the PolyForm Noncommercial License. **Companion Portal** and **Companion Memory** remain closed-source products. When you review Portal interactions, treat a modified Hub as an **untrusted Portal client**.

Use this page to review the trust boundaries between these products. It is not a penetration test report.

Reviewed against CI-Portal `origin/dev` @ `b5d539b8` (2026-09-03) and this Hub branch. GET install requires `x-device-key` in [CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634).

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

| Method | Caller | Auth | Role |
|---|---|---|---|
| `POST` | Portal session (person in the store UI) | `sessionMiddleware` plus organization membership over the named device | Portal **pushes** an install command to that Hub |
| `GET` | Hub (`downloadAppFiles`) | `deviceAuthMiddleware` (`x-device-key`) — [CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634) | Hub **pulls** the install bundle |

After pairing, Hub stores `ciHubApiKey` and **always tries** to send it as `x-device-key` (and `Authorization: Bearer`) on GET install and on `POST /api/devices/registry-token`. Portal must reject a missing or unknown key with `401`. Paid GET bundles still require a completed transaction for the device bound from that key, not a client-supplied `x-device-id`.

A modified Hub can still compose and run **local or unsigned** apps. That must not unlock paid Portal artifacts, registry pulls, or other users' Portal sessions.

### If this machine cannot pair

Hub still attempts those Portal calls. Without a stored device key, Portal returns `401`. Marketplace installs do not finish. Registry listing falls back to an empty tag list (`RegistryService.getDeviceRegistryToken`), so the catalog can look **slow or empty** rather than obviously unauthorized. Complete pairing (`cihub register` or the onboarding UI) before you expect store installs to work.

## Capabilities of a modified open-source Hub

| Action | Possible without stolen Portal credentials? | Notes |
|---|---|---|
| Impersonate another paired device at Portal | No, on routes that use `deviceAuthMiddleware` | Needs that device's Portal-issued key |
| Impersonate a Portal end-user (OIDC) | No | Hub verifies Portal JWTs via JWKS; forging needs Portal keys |
| Download a **free** store install bundle | No, once [CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634) is deployed | Needs a Portal-issued device key |
| Download a **paid** store install bundle | No | Key plus a completed transaction for **that** device |
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

[Issue #722](https://github.com/companionintelligence/CI-Hub/issues/722) tracks Hub-side entitlement checks before install, start, and update operations. Until those checks ship, **Portal's fail-closed device-key routes** (pairing, GET/POST install, registry-token, tunnels) are the commercial gate.

## Review checklist for publication

- [x] Registry-token: Portal rejects a missing or invalid `x-device-key` (`MintRegistryToken` + `deviceAuthMiddleware`; covered by Portal tests).
- [ ] GET install bundle: Portal must reject a missing or invalid `x-device-key`. Implemented in [CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634); tick after merge.
- [x] Portal does not treat Hub-reported entitlement claims as authoritative on POST install (session + membership + payment/transaction).
- [x] Forward-auth documentation states Hub-signed headers apply only to apps on that appliance (this page + architecture).
- [x] Memory and Portal remain closed-source; the Hub license does not relicense them ([License FAQ](../License-FAQ.md)).
