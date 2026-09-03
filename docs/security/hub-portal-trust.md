# Hub and Portal trust (open-source Hub)

Companion Hub can be published under the PolyForm Noncommercial License while **Companion Portal** and **Companion Memory** stay closed. Treat a modified Hub as an **untrusted client of Portal**.

This page is for operators and reviewers. It is not a penetration-test report.

## Trust boundaries

| Boundary | Who is trusted | What it covers |
|---|---|---|
| Portal ↔ Hub device | Portal | Pairing, device API key, store install payloads, registry JWTs, tunnels |
| Hub ↔ apps on the appliance | Hub (local) | Traefik forward-auth headers, memory-connect, wake hooks |
| Hub ↔ Memory | Shared appliance secrets | HMAC / connect signing; Memory remains closed-source |

## Device identity

1. During pairing, Portal issues a device credential stored on Hub as `ciHubApiKey`.
2. Outbound Hub calls to Portal send `Authorization: Bearer <ciHubApiKey>` and `x-device-key: <ciHubApiKey>` (`PortalClientService.getDeviceAuthHeaders()`).
3. Hub can set a local `DEVICE_ID` for diagnostics. **Portal must bind device id to the issued key.** A forked Hub cannot invent another device’s key.

## Marketplace install and registry

- Hub requests install artifacts with an authenticated Portal call (for example `GET /api/store/{slug}/install`).
- Portal returns `401` / `403` / `402` when the device is unauthorized or not entitled. Hub maps those errors for the UI; it does **not** replace Portal as the entitlement authority.
- Registry pulls mint short-lived tokens through Portal (`/api/devices/registry-token`) with the same device key.
- A modified Hub can still compose and run **local or unsigned** apps. That must not yield paid or private Portal bundles if Portal fails closed.

## What a modified open-source Hub can and cannot do

| Action | Feasible without stealing Portal credentials? | Notes |
|---|---|---|
| Impersonate another paired device at Portal | No | Needs that device’s Portal-issued key |
| Impersonate a Portal end-user (OIDC) | No | Hub verifies Portal JWTs via JWKS; forging needs Portal keys |
| Skip Portal entitlement for marketplace downloads | Only if Portal fails open | Hub can ignore HTTP errors locally but will not receive signed install payloads or registry access |
| Run arbitrary local Docker apps | Yes | Appliance control plane is local |
| Forge Traefik forward-auth identity for apps that trust Hub HMAC | Yes | Whoever controls Hub and `CI_HUB_FORWARD_AUTH_SECRET` (or the per-app secret) can mint `X-CI-Hub-User` headers. That trust is **appliance-local**, not Portal authority |

## Memory-connect and wake

- Browser memory-connect requires a Hub session (`AuthGuard`).
- Managed app keys bind to an app URN; do not treat internal-network IP allowlists as the security boundary.
- Agent wake / notify stays on the appliance (Hub → app wake hooks). It does not grant Portal marketplace rights.

## Entitlements follow-up

Hub-side entitlement pre-flight before install/start/update is tracked separately in companionintelligence/CI-Hub#722. Until that ships, **Portal fail-closed behavior is the commercial gate**.

## Review checklist before public Hub

- [ ] Portal rejects missing/invalid `x-device-key` on install and registry-token routes
- [ ] Portal does not treat Hub-reported entitlement claims as authoritative
- [ ] Forward-auth docs state that Hub-signed headers are only for apps on that appliance
- [ ] Memory and Portal remain closed; this Hub license does not relicense them ([License FAQ](../License-FAQ.md))
