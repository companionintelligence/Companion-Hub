# Session Worksheet — Hub custom-domain binding

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `hub-custom-domain-binding` |
| **Date** | 2026-08-27 |
| **Agent** | Claude |
| **Model** | Opus 5 |
| **Task** | CI-Hub#1181 — Hub discards `customDomains[]` from tunnel sync |

---

## Goal

Make an app served on a customer's own hostname emit that hostname instead of the platform one.
CI-Cloud already reports the custom hostnames it cloned into a device's tunnel ingress on
`POST /api/tunnels/state`; the Hub dropped the field at the wire type and never read it, so an app
reached at `comfy.acme.com` loaded but still built every absolute URL — including the OAuth
`redirect_uri` — from `comfyui-hub-core2-acme.companionintelligence.com`.

---

## Steps taken

1. Verified all three gaps in the issue against CI-Hub and CI-Portal on `dev` before writing code.
2. Kept the wire field: `postTunnelState` declares `customDomains`; `syncStateOnce` validates the
   elements and drops malformed ones, as it already does for `failures`.
3. Mirrored delivered hostnames onto `app.custom_domain` (migration 0053) from a successful sync,
   joining on the app's own platform hostname.
4. Made env generation emit the bound hostname, and made the Traefik `X-Forwarded-Host` header and
   the edge-SSO host map read the same value from the same row.
5. Delivered the change through `pendingRestart` rather than recreating containers on a sync.
6. Three review passes; each found real defects, listed under Decisions.

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| The Hub mirrors CI-Cloud's array, never re-derives entitlement | Only CI-Cloud knows whether a hostname is really routed here; a Hub guess would have an app sign redirects for an address nothing answers on |
| `undefined` ≠ `[]` end to end | An older Portal sends no field; reading that as "none" would unbind every app serving on a custom hostname. `[]` is a real instruction to unbind |
| A payload nothing could parse changes nothing | One wire regression would otherwise unbind every app on every Hub in a single heartbeat |
| Bind via `pendingRestart`, never auto-recreate | A background heartbeat must not take a running app down under the user |
| Write with `updateAppByIdIfStatus` | The app snapshot predates the CI-Cloud round trip, so a blind write raced `settleCommandOutcome` and left the row bound with the badge cleared and the env stale — permanently, since `next === current` never re-raises |
| Base-URL correction applies to the form value too | The install dialog pre-fills `app_base_url` with the platform URL and it persists into `app.config`, so a correction living only in the env branch never ran for UI-installed apps |
| Hostname shape check mirrors CI-Cloud's, no stricter | Rejecting anything CI-Cloud accepted would withhold a domain that is already serving |
| Skipped: port-expose apps on an open host port | They set `exposedLocal` *and* `openPort`, so a connected domain genuinely serves but there is no compose env to carry it — the fix is display-shaped and needs a product decision |

---

## Files touched

- `packages/common/src/public-web/custom-domains.ts` (new) — wire parsing, normalization, selection
- `packages/backend/src/core/database/drizzle/0053_app_custom_domain.sql` (new) + schema/journal
- `packages/backend/src/core/portal/portal-client.service.ts` — wire type
- `packages/backend/src/modules/cloudflare/cloudflare-client.service.ts` — validation + surfacing
- `packages/backend/src/modules/app-lifecycle/exposure-sync.service.ts` — reconcile
- `packages/backend/src/modules/app-lifecycle/commands/command.ts` — Traefik `X-Forwarded-Host`
- `packages/backend/src/modules/auth/forward-auth-secret.resolver.ts` — edge-SSO host map
- `packages/backend/src/modules/apps/app.helpers.ts` — env generation
- `packages/backend/src/modules/apps/apps.repository.ts` — narrow `getAppCustomDomain` read
- `packages/backend/src/modules/apps/apps.service.ts`, `dto/app.dto.ts`
- `packages/backend/src/modules/public-web/public-web.service.ts` — diagnostics
- `packages/frontend/src/modules/app/**`, `packages/frontend/src/lib/cloudflare-api.ts`
- `docs/system/backend.md`, `docs/system/frontend.md`

---

## Tests run

- [x] `pnpm run lint:ci`
- [x] `pnpm run tsc` (backend, common, frontend)
- [x] `pnpm test` — backend 2596, common 176, frontend 1325
- [x] `pnpm run test:integration` — 10 passed against real Postgres + real migrations
- [x] App run — verified end to end against the DEPLOYED dev Portal
      (`hub.companionintelligence.com`) with real Cloudflare for SaaS and real Entri:
      `customDomains[]` delivered on the tunnel sync, joined on the app's platform hostname,
      `custom_domain` written, `pendingRestart` raised, and the restart regenerated the env —
      `APP_PUBLIC_URL`/`APP_BASE_URL`/`APP_HOST`/`APP_DOMAIN` all `https://wordpress.ci9.pw`
      inside the running container instead of `wordpress-<hub>-<org>.companionintelligence.com`.
- [ ] `bin/agent-validate-shift`

---

## Open items / handoff

- **The live OAuth run is still open.** The mechanism is verified end to end, but the acceptance
  test the issue calls the one that matters needs a connected domain on a real Cloudflare-for-SaaS
  zone. Worth doing on a fleet Hub before #1181 is closed.
- **Gap 3 (parked domains at install time) is not in this PR.** It needs a CI-Portal listing *and*
  bind endpoint designed alongside it.
- **Port-expose apps in cloudflare mode** (`exposedLocal && openPort`) can have a domain that serves
  but no compose env to carry it. Their link, probe and access-points card still show the platform
  hostname. Needs its own issue.
- **`emit('app', data, appUrn)` publishes to a topic nothing subscribes to.** Fixed at the three
  live call sites; the trap itself remains representable and the existing tests assert the broken
  form. Worth making unrepresentable.
- **Testing this locally needs a lifecycle event on a DIFFERENT app.** The sync that carries
  `customDomains[]` runs from inside the lifecycle command that triggered it, and
  `reconcileCustomDomains` deliberately skips an app that is `starting`/`restarting` — so
  restarting the app you are trying to bind can never bind it. There IS a post-settle sync that
  would (`AppLifecycleService`, the `settleCommandOutcome` callback), but it is gated on
  `isProduction`, so on a source-dev Hub it never fires. Install or restart any second app while
  the target app sits `running`, and the binding lands on that sync. On an appliance the
  post-settle sync makes the app's own restart sufficient.
- **`isProdEnv && app.exposedLocal` gates a correctness path on the environment.** Pre-existing,
  not introduced here, and out of scope for this PR — but a binding that is delivered in
  production and silently not delivered in development is a difference that hides real defects
  from local testing (it cost an hour in this session, and produced a false bug report). Worth
  its own ticket to decide whether the gate belongs there at all.
- GitHub Actions is budget-blocked org-wide, so nothing in this PR ran in CI.

---

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| Post-implementation | self-review | Opus 5 | Found the app-name/URN collision that unbound a stopped app sharing a name |
| `/code-review max --fix` | multi-angle | Opus 5 | 15 findings; the restart race that silently and permanently dropped a binding |
| `/code-review max --fix` | multi-angle | Opus 5 | 15 findings; the base-URL correction was unreachable for UI-installed apps |
