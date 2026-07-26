# ADR 002: Sibling public hostnames + edge ticket SSO

## Status

Accepted (2026-07-26)

## Context

Public Hub and app hostnames are **siblings** under a shared zone root, e.g.:

- Hub: `hub-<device>-<org>.companionintelligence.com`
- App: `<app>-<device>-<org>.companionintelligence.com`

Built by Hub [`packages/common/src/public-web/identity.ts`](../../packages/common/src/public-web/identity.ts) and Portal `buildApplicationHostname`. Portal owns DNS CNAMEs and Cloudflare tunnel ingress.

Browsers scope cookies to a host (or a Domain suffix). After Hub login, `getCookieDomain` sets `Domain=.<hub-host>`. That cookie is **not** sent to sibling app hosts. Historical LAN SSO worked when Hub sat at an apex (`ci.lan`) and apps were children (`app.ci.lan`).

Local app open already uses `http://127.0.0.1:{port}` ([ADR 001](./001-local-app-access-localhost-port.md)) and does not depend on this cookie dance.

PR #934 implements **edge ticket SSO**: after Hub login, a short-lived, single-use ticket walks the browser to the app host, which plants a session cookie there via Traefik forward-auth.

## Decision

1. **Keep sibling public hostnames.** Do not nest apps under the Hub host (`<app>.hub-….<root>`).
2. **Edge ticket SSO is the intentional remote SSO model** for Cloudflare / public sibling hosts — not a temporary workaround. Harden and keep `/api/auth/edge-sso` + `/api/auth/traefik` consume.
3. **Never** set session `Domain` to the shared public zone root (e.g. `.companionintelligence.com`). That would share sessions across tenants.
4. **Local open stays ports** (ADR 001). Ticket SSO must not apply to `localhost` / `127.0.0.1` redirect targets.
5. **`localDomain` remains tunnel/Traefik origin identity** (`httpHostHeader`), not a user-facing local browse URL.

### Why not nest under the Hub host?

Nesting would let `Domain=.<hub-host>` cover app children without tickets, but it requires multi-level TLS (`*.hub-….<root>` beyond Universal SSL’s one-label wildcard), more cert provisioning, and a larger DNS/cert surface to operate and protect. That cost is rejected for the product.

### Why not path-prefix under the Hub host?

Many upstream apps assume URL root `/`, break under `/apps/<slug>/`, or need base-path config we cannot set. Rejected as the default public model.

## Consequences

- Remote visitors may see one Hub → app redirect hop when first signing into an exposed app (ticket mint/consume).
- Ticket properties that must hold: authenticated mint, host-bound target allowlist, ~60s TTL, single-use burn, no open redirects, no ticket left in app logs/URLs after consume.
- Tunnel visitors are detected via `cf-ray` so return URLs use **public** Hub/app hostnames (tunnel rewrites Host to `*.localDomain` origins that only resolve on LAN).
- Identity builders stay flat `{app}-{device}-{org}.{root}`; no Portal/Hub hostname migration for nesting.

## Alternatives considered

| Approach | Outcome |
|---|---|
| Nest apps under Hub host | Rejected — cert/ops/security surface |
| Cookie `Domain=.<public-root>` | Rejected — cross-tenant session leak |
| Path-prefix under Hub | Rejected — breaks upstream apps |
| Edge ticket SSO (#934) | **Accepted** for public sibling hosts |

## Related

- [ADR 001 — Local app access uses localhost:port](./001-local-app-access-localhost-port.md)
- `AuthController` `/api/auth/traefik` and `/api/auth/edge-sso` (CI-Engineering#77)
