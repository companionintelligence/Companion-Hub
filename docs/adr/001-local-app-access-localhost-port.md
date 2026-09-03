# ADR 001: Local app access uses localhost:port; ci.lan is deprecated

## Status

Accepted (2026-06-23)

## Context

CI-Hub historically routed local app access through a LAN hostname (`ci.lan`) and Traefik `Host()` rules (e.g. `https://app.ci.lan`). Hub API access has already moved to `http://localhost:5002` (browser same-origin, Tauri probe, registration callbacks). Three URL strategies coexisted, causing stale defaults in `/api/user-context` and guest-dashboard links that pointed at unreachable hostnames.

## Decision

1. **Local app access is always `http://127.0.0.1:{port}`** (or `localhost:{port}` in UI copy). Installed apps with `exposureMode: local` skip Traefik hostname routing.
2. **`DEFAULT_LOCAL_DOMAIN` is `localhost`** — last-resort fallback only when both `LOCAL_DOMAIN` and `DOMAIN` env vars are unset.
3. **`/api/user-context`** resolves `localDomain` from `ConfigurationService`, not a hardcoded constant.
4. **Guest dashboard** opens apps by port, not `https://{sub}.{localDomain}`.
5. **Cloudflare / Tailscale exposure** continues to use hostname-based routing via `buildOriginServerName()` and public domains — this is intentional and unrelated to local access.

## Consequences

- Settings "Local domain" field remains for tunnel/Traefik origin routing on cloudflare-exposed apps, but is no longer used for opening local apps in the UI.
- E2E tests and docs that require `/etc/hosts *.ci.lan` should migrate to `*.localhost` (follow-up, P3).
- Intentional remaining `ci.lan` references: tunnel origin server names, Traefik test fixtures, and legacy compose builder tests — not user-facing local open paths.

## Alternatives considered

- Keep `ci.lan` with `/etc/hosts` setup — rejected; adds operator friction and breaks Tauri/desktop flows.
- Route all local apps through Traefik on `localhost` — rejected; direct port binding is simpler and already implemented in `app-access-points.tsx`.
