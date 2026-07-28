# Session Worksheet — Private VPN memory-connect origins

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `private-vpn-memory-connect-origins` |
| **Date** | 2026-07-28 |
| **Agent** | Claude Code |
| **Model** | Fable |
| **Task** | CI-Engineering#78 — memory connect unusable over Private VPN |

---

## Goal

Make the tailnet a first-class origin for the memory-connect flow. Before this session, a hub with the Private VPN active served apps over `*.ts.net` but pinned every connect launcher to the Cloudflare tunnel origin; VPN-only installs could not attach memory at all, and the Hub itself was not published over the VPN.

---

## Steps taken

1. Adversarially re-verified every CI-Engineering#78 claim against the code and live on core-2 (one correction posted: the subnet-route failure mechanism).
2. Added `buildHubTailnetOrigin` / `isTailnetHostname` to `hub-origin.ts`.
3. Published the Hub itself via Tailscale Serve on `:443` in the exposure-sync reconcile (upstream `ci-os-hub:5002` in sidecar mode — Traefik has no router for tailnet hosts) and triggered the reconcile from `auth/check` when browser sign-in lands.
4. Added a `tailnet` caller locality (`.ts.net` + CGNAT range, checked before the private-host test) and a tailnet launcher branch in `resolveLaunchers`, independent of tunnel health; tailnet origin added to `resolveFlowOrigin`, `resolveSafeNext`, and the `CI_HUB_ORIGINS` allowlist injected into ci-memory.
5. Added `getStatusCached` (30s TTL) to `TailscaleService` so the hot status-poll path never shells out per request.
6. Corrected `docs/private-vpn.md` (sidecar deployments serve the dashboard at `https://<node>/`; the `:5002` direct form is host-mode only; subnet-route caveats).
7. Built the branch image on core-2, swapped it in, and verified end-to-end: hub UI over VPN, tailnet launcher for `.ts.net` and CGNAT callers with tunnel up AND down, ceremony `/start` → `/login` staying on the tailnet origin, ci-memory allowlist carrying both origins.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Tailnet launcher only for tailnet callers | An `unknown`/`local` caller may not be able to resolve `*.ts.net`; offering it would trade one dead button for another. |
| Gate tailnet origin on `httpsAvailable` | Serve needs tailnet HTTPS certs; without them the origin cannot be published, so advertising it would hand out a dead launcher. |
| CGNAT (100.64/10) reclassified from `local` to `tailnet` | A VPN caller may be nowhere near the appliance's LAN; the LAN launcher could strand it. |
| Hub serve entry lives in the desired-ports reconcile | The GC loop below it unserves unknown ports; a separate serve call would be garbage-collected every sync. |
| Sidecar hub upstream is `ci-os-hub:5002`, not `traefik:80` | Traefik routes by Host and 404s tailnet hostnames (verified live). Overridable via `TAILSCALE_HUB_UPSTREAM`. |

---

## Files touched

- `packages/backend/src/common/helpers/hub-origin.ts` (+ tests)
- `packages/backend/src/modules/tailscale/tailscale.service.ts`
- `packages/backend/src/modules/tailscale/tailscale.controller.ts`
- `packages/backend/src/modules/app-lifecycle/exposure-sync.service.ts`
- `packages/backend/src/modules/memory-connect/memory-connect.service.ts` (+ launcher tests)
- `packages/backend/src/modules/apps/app.helpers.ts`
- `docs/private-vpn.md`

---

## Tests run

- [x] Biome on changed files
- [x] `tsc --noEmit` (backend)
- [x] `pnpm test` (backend, full suite: 2132 passed)
- [x] Live run on core-2 (branch image swapped over the running hub; full connect-flow verification, tunnel up and down)
- [x] `bin/agent-validate-shift --skip-openapi --skip-visual --skip-benchmark`

---

## Open items / handoff

- Local vitest v8-coverage began failing with `ENOENT coverage/.tmp/coverage-N.json` late in the session (environment glitch — the identical suite passed with coverage at 14:25 after all changes were in, and passes with `--coverage.enabled=false`). Worth re-running the gate on a clean checkout / CI.

- ci-memory only picks up a `CI_HUB_ORIGINS` change on env regeneration + recreate. Hub boot rehydration wrote the new value; consider regenerating + restarting the provider automatically when the VPN connects/disconnects.
- The stale-tunnel-health window (#78 finding 3) is only mitigated: tailnet/LAN callers no longer depend on tunnel health, but a caller genuinely on the public origin can still briefly receive a dead public launcher after an outage starts.
- A fully VPN-only ceremony also needs Companion Memory itself on `tailscale` exposure (consent page origin); with it on `cloudflare` exposure the consent hop still rides the tunnel.
- core-2: host `/data` contains pre-existing March-era data plus two stray root-owned artifacts from a mis-parameterised compose run during testing (`/data/secrets/.env.secrets` — freshly generated, unused values; `/data/objects/.minio.sys`). Left in place deliberately.

---

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| research | verification pass | Fable | Ticket #78 claims re-verified against code + live core-2 before implementation |
