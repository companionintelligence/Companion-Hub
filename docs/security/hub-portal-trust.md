# Trust between Companion Hub and Companion Portal

Companion Hub uses the PolyForm Noncommercial License. **Companion Portal** and **Companion Memory** remain closed-source products. When you review Portal interactions, treat a modified Hub as an **untrusted Portal client**.

Use this page to review the trust boundaries between these products. It is not a penetration test report.

## Trust boundaries

| Boundary | Who is trusted | What it covers |
|---|---|---|
| Portal ↔ Hub device | Portal | Pairing, device API key, store install payloads, registry JWTs, tunnels |
| Hub ↔ apps on the appliance | Hub (local) | Traefik forward-auth headers, memory-connect, wake hooks |
| Hub ↔ Memory | Shared appliance secrets | HMAC / connect signing; Memory remains closed-source |

## Device identity

1. During pairing, Portal issues a device credential that Hub stores as `ciHubApiKey`.
2. Hub sends `Authorization: Bearer <ciHubApiKey>` and `x-device-key: <ciHubApiKey>` on outbound Portal calls (`PortalClientService.getDeviceAuthHeaders()`).
3. You can set a local `DEVICE_ID` for diagnostics. **Portal must bind the device ID to the issued key.** A forked Hub cannot create another device's key.

## Marketplace install and registry

- Hub requests install artifacts through an authenticated Portal call, such as `GET /api/store/{slug}/install`.
- Portal returns `401`, `403`, or `402` when the device lacks authorization or entitlement. Hub maps these errors for the UI; it does **not** replace Portal as the entitlement authority.
- For registry pulls, Portal mints short-lived tokens at `/api/devices/registry-token` by using the same device key.
- A modified Hub can compose and run **local or unsigned** apps. If Portal fails closed, the modified Hub cannot obtain paid or private Portal bundles.

## Capabilities of a modified open-source Hub

| Action | Possible without stolen Portal credentials? | Notes |
|---|---|---|
| Impersonate another paired device at Portal | No | Needs that device’s Portal-issued key |
| Impersonate a Portal end-user (OIDC) | No | Hub verifies Portal JWTs via JWKS; forging needs Portal keys |
| Skip Portal entitlement for marketplace downloads | Only if Portal fails open | Hub can ignore HTTP errors locally but will not receive signed install payloads or registry access |
| Run arbitrary local Docker apps | Yes | Appliance control plane is local |
| Forge Traefik forward-auth identity for apps that trust Hub HMAC | Yes | Whoever controls Hub and `CI_HUB_FORWARD_AUTH_SECRET` (or the per-app secret) can mint `X-CI-Hub-User` headers. That trust is **appliance-local**, not Portal authority |

## Memory-connect and wake

- Require a Hub session for browser memory-connect (`AuthGuard`).
- Bind managed app keys to an app URN. Don't treat internal-network IP allowlists as the security boundary.
- Keep agent wake and notify operations on the appliance (Hub → app wake hooks). These operations don't grant Portal marketplace rights.

## Entitlements follow-up

[Issue #722](https://github.com/companionintelligence/CI-Hub/issues/722) tracks Hub-side entitlement checks before install, start, and update operations. Until those checks ship, **Portal's fail-closed behavior is the commercial gate**.

## Review checklist for publication

- [ ] Verify that Portal rejects a missing or invalid `x-device-key` on install and registry-token routes.
- [ ] Verify that Portal doesn't treat Hub-reported entitlement claims as authoritative.
- [ ] State in the forward-auth documentation that Hub-signed headers apply only to apps on that appliance.
- [ ] Confirm that Memory and Portal remain closed-source and that the Hub license doesn't relicense them ([License FAQ](../License-FAQ.md)).
