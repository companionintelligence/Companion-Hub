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
| 0b | Provision the Docker Hub pull-through cache (mirror + authed upstream) | `provision-docker-cache.mjs` |
| 1 | Boot the e2e web UI, run the catalog across the fleet | `fleet-qa-server.ts` (dashboard) + `fleet.json` |
| 2 | Triage results → fan out diagnose+fix+PR subagents | `triage.mjs` + the Agent tool |

`drive-qa.mjs` is the per-app local detector the Phase-2 fix agents use to
reproduce a bug without the fleet.

> Paths are relative to `CI-Hub/` (the unit root). Read-only/local commands below
> were run and verified this session; commands that **mutate the fleet or start a
> multi-hour run are marked ▶ TRIGGER** — run them when you're ready.

## The fleet (8 nodes)

`fleet.json` (next to this skill) is the source of truth and the `FLEET_CONFIG_JSON`
the dashboard reads. **Re-verify it before every run** — tailnet names drift and nodes
come and go. Verified reachable over Tailscale SSH (`ci@…`) on 2026-08-18:

| Node | Tailscale IP | Batch | Notes |
|------|-------------|-------|-------|
| core-10 | 100.87.68.116 | 0 | OS hostname is `ci` |
| beta-max | 100.115.174.32 | 1 | no `~/.docker/config.json` → pulls anonymously |
| beta-ms-a2 | 100.119.230.14 | 2 | dbus dead → `cgroupfs` driver, manual dockerd |
| fzzy | 100.114.164.27 | 3 | must use the `default` docker context, not Desktop |
| core-7 | 100.83.30.11 | 4 | |
| bench-1 | 100.67.181.7 | 5 | OS hostname is `core-17` |
| beta-glass | 100.86.79.25 | 6 | smallest node (8 cpu / 31G) |
| liam-core | 100.98.33.44 | 7 | OS hostname is `liam-demo` |

**Tailnet name ≠ OS hostname.** `tailscale status` prints the *tailnet* name; several
nodes report a different `hostname`. Always key off the IP, never the name.

**Not usable:** `core-2`, `beta-nas`, `beta-red` are reachable but have **no passwordless
sudo**, so their dead registry mirror can't be removed (see Phase 0b). `core-1`, `core-6`,
`bench-2` are offline. `core-4` runs a live CI-Memory/Hermes stack — do not disturb it.
`*-kvm` peers are IPMI/PiKVM devices, not test targets. **beta-1 is the driver only** — it
has no sshd and no passwordless sudo, so it cannot be a worker.

**Prereqs:** the driver's Tailscale must be **up** and the tailnet SSH ACL must grant it
`tag:ci-server` as `ci`. Each node needs Docker, Node ≥18, and a `tsx` **on the
non-interactive SSH PATH** — `npm i -g tsx` often lands in `~/.npm-global/bin`, which is
*not* on that PATH, so symlink it: `sudo ln -sf "$(command -v tsx)" /usr/local/bin/tsx`.

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

## Phase 0b — Docker registry mirror (cache RETIRED)

The pull-through cache lived on **core-1, which is now offline** — but every node still
mirrored to `100.108.17.53:5050`. A dead mirror does **not** fail fast: pulls hang until
they time out, so a full run scores mass `error` verdicts that look like app bugs.

The mirror has been **stripped fleet-wide**; nodes now pull direct from Docker Hub using
their own `~/.docker/config.json` auth. Assert no node has regained a dead mirror:

```bash
# should print nothing for every node
for ip in 100.87.68.116 100.115.174.32 100.119.230.14 100.114.164.27 \
          100.83.30.11 100.67.181.7 100.86.79.25 100.98.33.44; do
  ssh ci@$ip 'grep -o "registry-mirrors" /etc/docker/daemon.json 2>/dev/null'
done
```

To strip one: remove `registry-mirrors` + `insecure-registries` from
`/etc/docker/daemon.json`, then restart Docker. `provision-docker-cache.mjs` still exists
if you ever re-host the cache — point `CACHE_NODE` at a node that is actually online.

**If you re-introduce a cache, authenticate its upstream.** Without Hub creds a cold sweep
of ~750 apps across 8 nodes sharing one public IP can trip the anonymous pull-rate limit.

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
| `timeout` | Never became ready within the readiness ceiling (no death signal) — usually a slow cold-pull/migration, occasionally a wedged node. Retried once; excluded from pass-rate (infra, not the app). |
| `error` | Harness/infra failure — bad config, pull failure, registry rate-limit. Excluded from pass-rate. |
| `skip` | Not a web app — `no_gui` (MCP/CLI), private `ghcr.io/companionintelligence/*`, GPU (`rocm`/`cuda`), VM (`dockurr/*`). Excluded from pass-rate. |

**The run never hangs.** Every app is force-failed to `timeout` past the readiness ceiling, every
docker op is SIGKILL-bounded, and a per-app watchdog (node side) plus a deadline watchdog +
state-based completion (server side) guarantee a verdict for every app even if a node's daemon wedges
or its SSH drops mid-app — the run completes the instant the queue is drained and nothing is in flight,
instead of hanging at N/total with in-flight apps that never resolve.

## Direct invocation

```bash
APP_STORE_DIR=../CI-Marketplace/apps RESULTS_DIR=/tmp/qa SKIP_SCREENSHOT=1 \
  ./node_modules/.bin/tsx scripts/qa-stream.ts uptime-kuma gitea
```

Env (qa-stream, per node): `APP_STORE_DIR` · `RESULTS_DIR` · `SKIP_SCREENSHOT=1` · `QA_CHROMIUM_PATH` ·
`QA_READY_TIMEOUT_MS` (readiness ceiling, default 300s single / 600s multi) · `QA_CONCURRENCY` (default
2) · `QA_APP_WATCHDOG_MS` (hard per-app backstop; default derived from the ceiling — only fires on a
wedged daemon). stdout is NDJSON: `batch_start` → per-app `app_start`/`app_phase`/`app_result` →
`batch_done`; the verdict is the `app_result` event's `result` (`score`, `backendHealthy`,
`httpStatus`, `readyVia`, `notes`; a watchdog/deadline force-fail carries `failKind:"watchdog"`).

Env (dashboard server): `QA_APP_DEADLINE_MS` (server force-fails an in-flight app with no verdict by
this, default 40 min — catches a fully-silent node) · `QA_RUN_MAX_MS` (absolute run backstop, default
6 h) · `QA_CACHE_NODE`/`QA_CACHE_PORT` (which node/port hosts the registry mirror preflight asserts).

## Architecture coverage (arm / x64) — `audit-arch.py`

The fleet runs each app on whatever node it lands on, and **all current nodes are
`x86_64`** — so a normal run never exercises arm64 at all. To *see* which apps even
publish an arm64 build (so they could install on an ARM CI-Hub appliance —
Apple-Silicon / Pi-class / ARM mini-PC), run the static manifest audit:

```bash
python3 .claude/skills/run-fleet-qa/audit-arch.py        # → arch-audit.json + arch-coverage.md
```

It reads every app's `docker-compose.json`, resolves each image's published platforms
and rolls up per app (`both` | `amd64-only` | `partial-arm` | `private` | `unknown`).
It spends **zero Docker Hub pull-limit budget**: Docker Hub images go through the
`hub.docker.com` REST API (throttled serially with 429 backoff), ghcr/lscr/codeberg/
quay through the registry v2 manifest-list API (anon bearer token + config-blob
fallback). `--cache arch-audit.json` reuses prior results and only re-resolves misses;
`export GHCR_TOKEN=$(gh auth token)` resolves the private `ghcr.io/companionintelligence/*`
images. A `partial-arm` verdict = the app image is multi-arch but a **dependency** image
(db/mailer) is amd64-only, so the stack still breaks on ARM — these are the fixable ones
(swap the dep for a multi-arch equivalent). To actually *run* arm64 on the x64 fleet you'd
need qemu binfmt + `--platform linux/arm64` (slow, emulated) or real ARM nodes — neither is
wired in yet.

## Node-level gotchas (these masquerade as app bugs)

A broken node poisons the whole run: work-stealing means it grabs a large share of the
queue and errors every app it touches. **Always check the per-node score split before
believing a wave of failures** — `error`s concentrated on one node are that node, not the
apps. Real cases from the 2026-08-18 sweep:

| Symptom in `notes` | Root cause | Fix |
|---|---|---|
| `Docker Desktop is unable to start` | node defaults to the `desktop-linux` context while a healthy system dockerd sits on `/var/run/docker.sock` | `docker context use default` |
| container `Created` then hangs on `Starting` forever | Docker on the `systemd` cgroup driver but **dbus is dead** (`systemctl` returns *Failed to connect to system scope bus*) | set `"exec-opts": ["native.cgroupdriver=cgroupfs"]` in `daemon.json`, restart dockerd |
| preflight FAILED right after provisioning a node | `tsx` installed to `~/.npm-global/bin`, not on the non-interactive SSH PATH | `sudo ln -sf "$(command -v tsx)" /usr/local/bin/tsx` |
| every pull hangs, then `error` | dead registry mirror (see Phase 0b) | strip `registry-mirrors` from `daemon.json` |

On a node with no `systemd` bus, `systemctl restart docker` cannot work at all. Restart by
killing dockerd and relaunching it directly:
`sudo sh -c "nohup /usr/bin/dockerd --containerd=/run/containerd/containerd.sock &"`.

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
| Many `error` verdicts: "unauthenticated pull rate limit" | The Docker Hub cache isn't wired on some nodes — run `provision-docker-cache.mjs` (Phase 0b) to assert/fix the mirror + authed cache. |
| Run stuck at N/total with apps "in flight" forever | Should no longer happen — the node + server watchdogs force-fail stuck apps to `timeout` and complete the run. If you see it, check the run log for `watchdog force-fail` lines; tune `QA_APP_DEADLINE_MS`. |
