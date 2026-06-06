---
name: run-fleet-qa
description: Run the CI-Hub fleet QA distributed across the Tailscale tailnet (core/beta nodes) — distribute the updated Hub to every fleet computer, boot the e2e web UI dashboard, run the test catalog across all nodes, then fan out background subagents to diagnose+fix+PR each failing CI-Marketplace app. Also the per-app local bug detector. Triggers: "run fleet qa", "distribute hub to the fleet", "run the e2e tests on the fleet", "qa the marketplace apps", "screenshot/test <app>", "fix the failing apps", "fleet-qa dashboard", "why does <app> fail QA".
---

# Run the CI-Hub fleet QA (distributed)

The fleet-QA harness boots every **CI-Marketplace** app's Docker container(s),
waits for health, screenshots the UI, and scores `pass | warn | fail | skip`. It
runs **distributed across the Tailscale fleet** — `core-*`/`beta-*` Linux nodes
each test a batch in parallel — driven from this Mac (`liambook`) via the e2e web
UI dashboard.

The full operation is a **three-phase pipeline**, each with a committed helper in
this skill dir (`.claude/skills/run-fleet-qa/`):

| Phase | What | Helper |
|-------|------|--------|
| 0 | Distribute the updated Hub to every fleet computer | `distribute-hub.mjs` |
| 1 | Boot the e2e web UI, run the catalog across the fleet | `fleet-qa-server.ts` (dashboard) + `fleet.json` |
| 2 | Triage results → fan out diagnose+fix+PR subagents | `triage.mjs` + the Agent tool |

`drive-qa.mjs` is the per-app local detector the Phase-2 fix agents use to
reproduce a bug without the fleet.

> Paths are relative to `CI-Hub/` (the unit root). Read-only/local commands below
> were run and verified this session; commands that **mutate the fleet or start a
> multi-hour run are marked ▶ TRIGGER** — run them when you're ready.

## The fleet (10 nodes)

`fleet.json` (next to this skill) is the source of truth and the `FLEET_CONFIG_JSON`
the dashboard reads. Verified reachable over Tailscale SSH (`ci@…`) this session:

| Node | Tailscale IP | Batch | Git auth |
|------|-------------|-------|----------|
| core-1 | 100.108.17.53 | 0 | ✅ pull-ready (registry cache :5050) |
| core-2 | 100.101.156.33 | 1 | ✅ pull-ready |
| core-6 | 100.95.23.128 | 2 | ✅ pull-ready |
| core-8 | 100.98.33.44 | 3 | ✅ pull-ready (deploy key `github-cihub`) |
| core-9 | 100.113.188.103 | 4 | ✅ pull-ready (deploy key `github-cihub`) |
| core-10 | 100.87.68.116 | 5 | ⚠ no git auth → tar-sync |
| core-14 | 100.101.186.74 | 6 | ⚠ no git auth → tar-sync |
| core-17 | 100.67.181.7 | 7 | ⚠ no git auth → tar-sync |
| beta-1 | 100.124.211.75 | 8 | ✅ pull-ready |
| beta-ms-a2 | 100.119.230.14 | 9 | ⚠ no git auth → tar-sync |

**Prereqs:** this Mac's Tailscale must be **up** (`tailscale status` → `Self.Online:True`)
and the tailnet SSH ACL must grant `liambook → tag:ci-server` as `ci`. Locally:
Docker running, Node 22, `pnpm install` done (for the dashboard + `drive-qa.mjs`).

## Phase 0 — Distribute updated Hub to the fleet

The whole fleet currently sits **7 commits behind `origin/dev`** in detached HEAD.
`distribute-hub.mjs` fast-forwards each node to `CI-Hub@dev`. **Dry-run first — it's
read-only and classifies every node** (this is real output from this session):

```bash
node .claude/skills/run-fleet-qa/distribute-hub.mjs
#   ✓ core-1   pull-ready   auth=ok head=712b1c12 behind=7 dirty=0
#   ⚠ core-10  NO GIT AUTH  auth=FAIL head=712b1c120 dirty=0  → needs --tar-from
#   6 pull-ready, 4 need tar-sync, 0 down.
```

Then distribute. **6 nodes `git pull`; the 4 no-auth nodes tar-sync from an authed
peer** (`--tar-from`) in the same command:

```bash
# ▶ TRIGGER — mutates all 10 nodes
node .claude/skills/run-fleet-qa/distribute-hub.mjs --execute --tar-from core-1
```

`--execute` runs `git checkout dev && git pull --ff-only` on the authed nodes (this
re-attaches them from detached HEAD), then pipes `tar c … CI-Hub` from `core-1` into
the no-auth nodes. `--only core-1,core-2` scopes it.

## Phase 1 — Boot the e2e web UI and run the distributed tests

The dashboard **is** the e2e web UI. Launch it pointed at `fleet.json`:

```bash
# ▶ TRIGGER — long-lived server; for a FULL run launch as a plain bg process (the
#   preview reaper kills :4242 mid-run and loses the in-memory scoreboard).
FLEET_CONFIG_JSON="$(cat .claude/skills/run-fleet-qa/fleet.json)" \
  QA_PORT=4242 ./node_modules/.bin/tsx scripts/fleet-qa-server.ts
```

Open `http://localhost:4242/` (the catalog grid + node selector + Preflight/Quick/
Full/Start controls — see `dashboard.png`). Recommended flow, via the UI or the HTTP
API (verified responding this session):

```bash
curl -s  http://localhost:4242/api/status | head            # per-app + per-node state
curl -sXPOST http://localhost:4242/api/preflight -H 'Content-Type: application/json' -d '{}'   # gate: SSH/Docker/tsx/marketplace per node
curl -sXPOST http://localhost:4242/api/start     -H 'Content-Type: application/json' -d '{"mode":"full"}'   # ▶ full catalog (quick = 9 priority apps)
curl -s  http://localhost:4242/api/results.json             # live scoreboard (poll this for a long run)
```

The dashboard auto-preflights, then SCPs **this Mac's** `scripts/qa-stream.ts` to
each node and fans the catalog out by batch. A full run is **multi-hour** (≤10 min/app
ceiling). Screenshots land on each node and are pulled to `~/qa-results/`; the live
scoreboard is `GET /api/results.json`.

## Phase 2 — Triage → fan out diagnose+fix+PR agents

When the run finishes, pull the scoreboard and turn it into a fix work-list:

```bash
curl -s http://localhost:4242/api/results.json > /tmp/qa-results.json
node .claude/skills/run-fleet-qa/triage.mjs /tmp/qa-results.json --json
#   results: N apps — … ACTIONABLE …
#   FAIL n8n        @core-2  http 0    db-race: app outran its DB → needs dependsOn service_healthy
#   WARN mastodon   @core-6  http 200  db-auth: stale pgdata / wrong password
#   wrote /tmp/worklist.json
```

`triage.mjs` keeps only **actionable** rows — `fail`, or `warn` with a **down backend**
— and drops the missing-screenshot false-warns (a provisioning gap, not a bug). Each
row gets a bug-class guess, an assigned pull-ready node, and repro commands.

**Fan out one subagent per `worklist.json` entry** (the Agent tool, `isolation:
"worktree"` so per-app fixes don't collide). Spawn them as background tasks and give
each this brief. **One PR per app, opened straight against CI-Marketplace `dev` — no
rollup branch:**

> You are fixing one CI-Marketplace app flagged by fleet QA: **`<appId>`**, scored
> `<score>`, bug-class hint **`<bugClass>`**, notes: `<notes>`.
> 1. Reproduce locally: `node .claude/skills/run-fleet-qa/drive-qa.mjs --screenshot <appId>` (or on its node: `<nodeRepro>`).
> 2. Read the manifest at `<manifest>` (`config.json` + `docker-compose.json`).
> 3. Fix per the bug-class patterns in this skill's Gotchas (dependsOn+healthcheck;
>    `${VAR}` form_field; `user:`/mount perms; `internalPort`; `mongo:8.2.x`; seed
>    `apps/<id>/data/`). Edit CI-Marketplace, NOT the harness, unless it's a harness bug.
> 4. Re-verify with `drive-qa.mjs` until `backendHealthy:true` and `httpStatus` 200–499.
> 5. Open a `qa-fix/<appId>` PR against CI-Marketplace `dev` with the before/after verdict.

The fix agents stay in CI-Marketplace; `drive-qa.mjs` only reads the harness.

## Local single-app repro (drive-qa.mjs)

The fast path with no fleet — used by the Phase-2 agents and for any one-off check:

```bash
node .claude/skills/run-fleet-qa/drive-qa.mjs --list                       # 169 marketplace app ids
node .claude/skills/run-fleet-qa/drive-qa.mjs uptime-kuma                   # boot + readiness + score (warn w/o screenshot)
node .claude/skills/run-fleet-qa/drive-qa.mjs --screenshot uptime-kuma gitea  # full pass (auto-finds Google Chrome on macOS); runs concurrently
```

It wraps `scripts/qa-stream.ts`, streams each phase, prints a verdict table, writes
`results.json`+`screenshots/` to a temp dir, exits non-zero only on `fail`, and tears
down every container on exit. Verified this session: `uptime-kuma` PASS (`http 200`,
real screenshot), `gitea` multi-service composeUp (`http 200`), `blender-mcp` SKIP.

### Reading the score

| Score | Meaning |
|-------|---------|
| `pass` | Ready (healthcheck or HTTP <500) **and** a screenshot was captured. |
| `warn` | Ready but **no screenshot** (no chromium on that node — false-warn), **or** frontend serves while a backend service is down/restarting (`backendHealthy:false`, failing svc + log excerpt in `notes` — the real warn). |
| `fail` | Never ready: never started, or exited / restart-looped before the ceiling. **The bug.** |
| `skip` | Not a web app — `no_gui` (MCP/CLI), private `ghcr.io/companionintelligence/*`, GPU (`rocm`/`cuda`), VM (`dockurr/*`). Excluded from pass-rate. |

## Direct invocation

```bash
APP_STORE_DIR=../CI-Marketplace/apps RESULTS_DIR=/tmp/qa SKIP_SCREENSHOT=1 \
  ./node_modules/.bin/tsx scripts/qa-stream.ts uptime-kuma gitea
```

Env: `APP_STORE_DIR` · `RESULTS_DIR` · `SKIP_SCREENSHOT=1` · `QA_CHROMIUM_PATH` ·
`QA_READY_TIMEOUT_MS` (default 300s single / 600s multi) · `QA_CONCURRENCY` (default
2). stdout is NDJSON: `batch_start` → per-app `app_start`/`app_phase`/`app_result` →
`batch_done`; the verdict is the `app_result` event's `result` (`score`,
`backendHealthy`, `httpStatus`, `readyVia`, `notes`).

## Gotchas

- **The fleet is auth-split.** Only 6/10 nodes can `git pull` (HTTPS creds or the
  `github-cihub` deploy key). core-10/14/17/beta-ms-a2 were tar-provisioned and have
  **no GitHub auth** — `git fetch` dies with `could not read Username for github.com`.
  Always `--tar-from` an authed node for those; a plain `git pull` distribute silently
  leaves them stale (and they can't even *see* they're behind — their `origin/dev` ref
  is frozen, so they falsely report `behind=0`).
- **Nodes run in detached HEAD.** The `--execute` path's `git checkout dev` re-attaches
  them before the ff-pull.
- **`POST /api/start` dispatches to the REAL fleet** the moment this Mac is on the
  tailnet — it returns `{"ok":true}`, logs `run_start`, but runs read-only preflight
  first, so killing the server within a few seconds dispatches nothing. Don't `/api/start`
  casually just to test the endpoint.
- **Interrupting a run does NOT stop the nodes.** `POST /api/stop` / killing the server
  only halts dispatch; SSH-spawned `qa-stream` keeps booting containers per node (seen
  pile up to 56 on one node). Clean a node with `pkill -9 -f '[q]a-stream'` (bracket
  trick — a plain `pkill -f qa-stream` self-matches the SSH shell) + remove its `qa-stream-*`
  containers. The local `drive-qa.mjs`, by contrast, tears everything down on exit.
- **The preview reaper kills `:4242` mid-run.** `../.claude/launch.json` registers
  `fleet-qa` as a preview server, so an IDE/preview may seize `:4242` and replace a
  hand-launched server — the in-memory scoreboard is lost (only screenshots persist; poll
  `/api/results.json`). For a full run, launch as a plain bg process and/or drop `fleet-qa`
  from `launch.json` first; let preview own it only for quick/debug runs.
- **~47 warns are usually FALSE** — backend-healthy apps on nodes without
  `~/.cache/ms-playwright` chromium (the tar-synced nodes). `triage.mjs` already drops
  these; to convert them to `pass`, sync the chromium cache from core-1 (`tar c … ms-playwright`).
- **`backendHealthy:false` bug classes** (the real warns/fails): (a) DB race →
  `dependsOn:{db:{condition:service_healthy}}`+healthcheck; (b) unsubstituted `${VAR}`
  secret → `random` form_field; (c) non-root image UID vs harness-owned mount perms
  (mattermost uid 2000, n8n uid 1000); (d) `internalPort` ≠ real listen port; (e)
  `mongo:6`/`8.0` on kernel ≥6.19 → `mongo:8.2.x`; (f) file-target bind mount with no
  seed in `apps/<id>/data/`. `triage.mjs` guesses the class from the notes.
- **Re-read `qa-stream.ts` before editing** — multiple agents co-edit it, and the
  dashboard SCPs **this Mac's** copy fleet-wide per run (so a local edit propagates with
  no push; but the node's stale checkout still supplies tsx/node_modules — Phase 0 fixes that).
- **Bash tool shell is zsh** → a space-joined `$NODES` string does NOT word-split in
  `for`. Use a zsh array `NODES=(name:ip …); for ni in "${NODES[@]}"`. `ssh -n` breaks a
  `bash -s` heredoc — use `</dev/null` on the receiver instead.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dry-run: `UNREACHABLE` on a node | This Mac's Tailscale down, or the SSH ACL doesn't grant `liambook→tag:ci-server` as `ci`. Check `tailscale status`; fix the ACL at login.tailscale.com/admin/acls. |
| Distribute: node `git pull failed` | A no-auth node — re-run `--execute --tar-from core-1`. |
| Every node preflight-fails in the UI | Same ACL/Tailscale issue, or `FLEET_CONFIG_JSON` not set (it falls back to stale built-in IPs — always pass `fleet.json`). |
| Run scoreboard vanished mid-run | Preview reaper took `:4242`. Relaunch bg, poll `/api/results.json`; screenshots survive on the nodes. |
| `tsx not found` locally | `pnpm install` in `CI-Hub/`. |
| `CI-Marketplace apps dir not found` | Clone CI-Marketplace beside CI-Hub or set `APP_STORE_DIR`. |
| Healthy app scores `warn` | Expected without chromium — not a bug; `triage.mjs` filters it. Add `--screenshot`/`QA_CHROMIUM_PATH` locally for `pass`. |
| App `fail` after a long `[http] Waiting…` | Cold image pull on a heavy app — raise `QA_READY_TIMEOUT_MS` or pre-pull (`scripts/prepull-images.ts`); stable once cached. |
