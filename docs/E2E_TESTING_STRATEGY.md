# E2E / Fleet QA Testing Strategy

> How CI-Hub verifies that every marketplace app actually **works** when deployed — not
> just that a page loads, but that the backend runs and is usable.

## Goal

A served frontend is not a working app. The recurring failure mode is "the page loads but
the backend is dead / there's no working login." The strategy below is built to **catch
that**, at the scale of the whole marketplace (≈170 apps), on real hardware.

## Two test layers

| Layer | Code | What it proves | Scale |
|-------|------|----------------|-------|
| **1. Fleet Docker QA** (primary) | `scripts/qa-stream.ts` + `scripts/fleet-qa-server.ts` | Each app's full `docker-compose` stack comes up, the **backend is healthy**, and the UI renders | All ≈170 apps across the Tailscale node fleet |
| **2. Hub-install regression** | `e2e/app-regression.spec.ts` + `e2e/generated/catalog-batch-*.spec.ts` | An app installs **through the real Hub** under one account (install → access → uninstall) and **serves** (HTTP `< 500`, no gateway/error page) | Playwright, per-batch |

Layer 1 is the fast, broad signal run continuously across the fleet. Layer 2 is the
high-fidelity, product-accurate path — it exercises the Hub's own compose builder and
Traefik routing — and is the source of truth when Layer 1 and reality disagree.

> **In-app login is recorded, not yet asserted.** `app-regression.spec.ts` *asserts* the
> app installs and serves (HTTP `< 500`, no gateway error), then calls `attemptAppAuth()` and
> records the result as `verdict: pass | warn` — a **failed in-app login is flagged `warn`,
> it does not fail the run**. The generated `catalog-batch-*` specs do Hub login + install/
> access/cleanup only and do **not** attempt in-app auth. So today neither layer hard-fails
> on a broken app login; treat the auth signal as advisory until it is promoted to an
> assertion (see Roadmap).

## What "working" means — scoring (Layer 1)

| Score | Meaning |
|-------|---------|
| `pass` | Ready (healthcheck `healthy` **or** HTTP `< 500`) **and** a screenshot rendered **and** the backend is healthy |
| `warn` | Ready, but no screenshot **or** the backend is **degraded** — frontend serves while a backend service is down/restarting (the "login broken" case). The failing service + a log excerpt are in `notes` |
| `fail` | Never became ready, or the main container exited / restart-looped |
| `skip` | Not an HTTP app — `no_gui` MCP/CLI, VM image (`dockurr/*`), GPU image (`rocm`/`cuda`/`amd-strix`), private `ghcr.io/companionintelligence/*`, or a dead/auth-failed image. Skips count as completed, they are **not** failures |

`warn` with a backend-degraded note is the most important signal — it is exactly the
"frontend up, backend down" bug that a naive HTTP-200 check hides.

## Readiness model (three signals, not a fixed timer)

A fixed HTTP poll tests the wrong thing: too short for slow boots, and it burns the whole
window on an app that already crashed. `qa-stream` instead waits on:

1. the container's own **Docker healthcheck** reporting `healthy` (authoritative when present);
2. **HTTP** `/` `< 500`; or
3. **fast-fail** — the main container `exited`/`dead` or restart-looped (report `backend exited after Ns` + logs, don't wait).

Ceiling: **300s single-service / 600s multi-service**, override with `QA_READY_TIMEOUT_MS`.
The result records `readyVia` (`healthcheck` | `http <code>`) and `startupMs`.

## Harness invariants (why apps that "should" work, do)

These are baked into `qa-stream` so the test deploys an app the same way production does:

- **Consistent `${VAR}` substitution.** Every `${VAR}` placeholder (admin passwords, secret
  keys, DB passwords) is filled with **one consistent value per variable**, reused across
  services — so a DB password the app and the database both reference actually matches.
  (Dropping `${VAR}` for single-service apps was the single biggest cause of broken logins.)
- **Full compose stack** for multi-service apps (DB/redis/workers), with `depends_on`
  health conditions rendered (`service_healthy` when the dep declares a healthcheck).
- **Honor `user:`** + wipe scratch dirs that a prior run left owned by root/uid-999 — fixes
  the bind-mount-UID crash class (non-root images over an empty harness-owned mount) and
  stale-volume DB-password mismatches. The Hub itself heals these at startup
  (`scripts/heal-hub-bind-mounts.ts`).
- **Prepull + registry cache** (core-1:5050) and a 900s pull timeout to kill cold-pull
  flakiness on heavy images.

## Environment gotchas (reusable)

- **MongoDB vs new kernels:** the nodes (and Ubuntu-26.04 prod Hubs) run kernel ≥ 6.19.
  `mongo:8.0.17+` **refuses to start** there (SERVER-121912); `mongo:8.0.16` only runs
  because it predates the guard and is below CVE fixes. Use **`mongo:8.2.x`** — it carries
  the real fix and is CVE-current. Any app pinned to `mongo:8.0` should move to `8.2.x`.
- **Playwright on Ubuntu 26.04:** `playwright install chromium` has no CDN build; screenshot
  drives a cached Chromium binary directly. Nodes provisioned by repo-sync lack
  `~/.cache/ms-playwright` → their apps `warn` (no screenshot) though the backend is fine.
- **Tailscale SSH ACL:** nodes serve SSH via tailscaled; `ssh ci@<ip>` returning
  "tailnet policy does not permit you to SSH to this node" is an **ACL denial**, not a
  network fault — fix the tailnet ACL.
- **Dashboard durability:** a full 10-node run takes hours; do **not** run the dashboard as
  a preview server (it gets reaped). Launch it as a background process and poll `/api/status`.

## Operating

```bash
# Dashboard (durable): from CI-Hub on the control machine
QA_PORT=4242 ./node_modules/.bin/tsx scripts/fleet-qa-server.ts &

# Drive it
curl -s -X POST http://127.0.0.1:4242/api/preflight -d '{}'          # check the fleet
curl -s -X POST http://127.0.0.1:4242/api/start -d '{"mode":"full"}' # run all apps
curl -s http://127.0.0.1:4242/api/status                             # poll results

# Regenerate the catalog after marketplace changes
APP_STORE_PATH=/path/to/CI-Marketplace/apps ./node_modules/.bin/tsx scripts/generate-catalog-tests.ts
```

The dashboard SCPs `qa-stream.ts` to each node per run, so editing it locally propagates
fleet-wide without a push. Results + screenshots land on each node under `~/qa-results-fleet/`.

## Roadmap / open items

- **Still failing** (genuine app bugs, not harness): `n8n` (crashes ~3s after start),
  `appflowy` (compose mount dir-vs-file).
- **Chromium** on the repo-synced nodes (core-8/9/10/14/17, beta-ms-a2) — sync the build
  from core-1 for clean `pass` vs `warn`.
- **Marketplace branches worth merging** (surfaced by QA, currently unmerged):
  `fix/adventurelog-anythingllm-images` (fixes `anythingllm:v1.11.2`→`1.11.2` and gives
  adventurelog a backend + postgis), `codex/add-postiz`, `codex/add-safeos`, and
  `feat/e2e-app-definitions` (#311 — per-app e2e metadata that should feed catalog generation).
- **Make in-app login a hard assertion.** Today `app-regression.spec.ts` records
  `attemptAppAuth()` as `warn`-only and the generated catalog specs don't attempt it, so a
  broken app login leaves the run green. Promote it to an `expect()` (at least for apps
  Layer 1 marks healthy) so a broken login fails the run.
