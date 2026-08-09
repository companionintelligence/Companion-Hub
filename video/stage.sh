#!/usr/bin/env bash
#
# The capture stage for Companion Hub.
#
# Sourced by video/make.sh (the kit's runner), which expects stage_up and
# stage_down, and defines capture_all so the shoot runs as two passes.
# Also runnable on its own:
#
#   ./video/stage.sh up        bring it up and print APP_URL
#   ./video/stage.sh down      stop it, and remove its containers
#
# This is the Hub's own E2E stage: Postgres + RabbitMQ in Docker, a mock Portal,
# the NestJS backend, and the frontend PREVIEW build (not dev — no HMR client and
# no dev overlay, so a rerun on unchanged UI is byte-identical). Ports are the
# video stage's own 919x band so a capture never collides with a Hub or an E2E
# run already using the defaults.
#
# ── THINGS THAT ARE LOAD-BEARING, AND WHY ────────────────────────────────────
#
# THE ENV MUST BE IN THE PROCESS ENVIRONMENT, not only in the .env that
# start-backend.sh writes. packages/backend/src/common/constants.ts reads
# process.env at MODULE LOAD, before that file is parsed:
#
#     export const APP_DATA_DIR = process.env.CI_HUB_APP_DATA_DIR || '/app-data';
#
# Omit them and the backend dies on ENOENT mkdir '/app-data'. Omit
# NODE_ENV=development and DatabaseService.getMigrationsPath() skips its dev
# branch and looks in $CI_HUB_APP_DIR/assets/migrations, which does not exist in
# a source checkout — the backend dies on "Can't find meta/_journal.json".
#
# NEVER LET THE FRONTEND BUILD RACE start-backend.sh. That script builds
# @ci-hub/common partway through its own run. Backgrounding it and building the
# frontend at the same time — the obvious reading of the README block — compiles
# the frontend against whatever packages/common/dist happened to be on disk,
# which in a fresh worktree is the PREVIOUS COMMIT'S. The capture then films a
# bundle that is not the tree you checked out and nothing reports it: the shots
# look plausible, capture exits 0, and check passes. This script builds common
# first, waits for the backend, and only then builds the frontend — and asserts
# the mtimes before capturing.
#
# CI_MARKETPLACE_DIR MUST BE A WORKTREE, NOT THE SHARED CLONE. downloadAppFiles
# WRITES INTO the marketplace checkout it reads from, so pointing this at
# ../CI-Marketplace dirties a clone other agents are using. If it is unset this
# script creates its own worktree and removes it in stage_down; if it is set, it
# refuses a checkout that is not one.
#
# hub-home MUST BE CAPTURED FIRST, IMMEDIATELY AFTER THE SEED. sync_app_statuses
# is a five-minute cron. It no longer empties the tile row — it now overlays a
# RED ERROR BADGE on each app logo, which is a frame that still renders, still
# passes check, and looks like three broken images on a contact sheet. Measured:
# a hub-home captured six minutes after the seed came back SSIM 0.9968 against
# the good frame. Small enough to skim past in a diff, fatal on screen.
#
# ONBOARDING IS PASS 2. onboarding-wizard drives the real /login form, and
# /login's clientLoader redirects a signed-in visitor to /home — so it only works
# from an un-onboarded state, which arm-onboarding.mts creates and then restores.
#
# WHAT THIS STAGE DOES NOT SHOOT: `running-app` and the eight other PARKED shot
# ids that are committed but not referenced by the current storyboard.
# `running-app` needs a genuine four-container Immich install, and installing
# Immich also swaps the store page's Install button for Open, which would change
# install-dialog. Re-shooting the parked ids is a deliberate, separate act —
# see video/README.md. This stage films the cut.
#
set -euo pipefail

_stage_root() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd; }

STAGE_WEB_PORT="${STAGE_WEB_PORT:-9191}"
STAGE_API_PORT="${STAGE_API_PORT:-9192}"
STAGE_PORTAL_PORT="${STAGE_PORTAL_PORT:-9193}"
STAGE_PG_PORT="${STAGE_PG_PORT:-9194}"
STAGE_MQ_PORT="${STAGE_MQ_PORT:-9195}"
STAGE_DATA_DIR="${STAGE_DATA_DIR:-/tmp/ci-hub-video}"
STAGE_LOG="${STAGE_LOG:-$(mktemp -t ci-hub-stage)}"
STAGE_PG_NAME="hub-video-pg"
STAGE_MQ_NAME="hub-video-mq"
# Set when this script created the marketplace worktree, so stage_down knows to
# remove it and never removes one the operator supplied.
STAGE_OWNS_MARKETPLACE=0

export APP_URL="${APP_URL:-http://localhost:$STAGE_WEB_PORT}"

_stage_wait() { # url, label
  for _ in $(seq 1 180); do
    curl -fsS -m 2 "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "stage: $2 never answered at $1" >&2
  tail -60 "$STAGE_LOG" >&2 || true
  return 1
}

# ── readiness, asked correctly ───────────────────────────────────────────────
# "Does this URL return 2xx?" is the wrong question for a server whose root is
# not a route. The mock portal answers 404 on `/` — it is perfectly healthy and
# serving /___control and /api/store/... — so `curl -fsS` fails, and the 2xx wait
# above burns its full 180 seconds before declaring a running server dead.
# Measured on the first real run of this stage.
#
# The right question for readiness is whether anything spoke HTTP at all, which
# is what a status code being present means. `%{http_code}` is 000 when the
# connection itself failed and the real code otherwise.
_stage_wait_http() { # url, label
  for _ in $(seq 1 180); do
    [ "$(curl -sS -o /dev/null -w '%{http_code}' -m 2 "$1" 2>/dev/null)" != "000" ] && return 0
    sleep 1
  done
  echo "stage: $2 never spoke HTTP at $1" >&2
  tail -60 "$STAGE_LOG" >&2 || true
  return 1
}

# ── the marketplace checkout ─────────────────────────────────────────────────
# e2e/start-backend.sh symlinks $CI_MARKETPLACE_DIR/apps into the Hub's store.
# Without it app-details, install-dialog and the installed-app tiles in hub-home
# have no app info to render — four empty screens, discovered afterwards.
_stage_marketplace() {
  local root="$1"
  if [ -n "${CI_MARKETPLACE_DIR:-}" ]; then
    git -C "$CI_MARKETPLACE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      || { echo "stage: CI_MARKETPLACE_DIR=$CI_MARKETPLACE_DIR is not a git checkout" >&2; return 1; }
    # A worktree has a .git FILE; a clone has a .git DIRECTORY. downloadAppFiles
    # writes into this tree, so a shared clone is the one thing it must not be.
    [ -f "$CI_MARKETPLACE_DIR/.git" ] || {
      echo "stage: CI_MARKETPLACE_DIR points at a CLONE, not a worktree." >&2
      echo "       downloadAppFiles writes into this checkout while it reads from it," >&2
      echo "       so this would dirty a clone other agents are working in. Make one:" >&2
      echo "         git -C $CI_MARKETPLACE_DIR worktree add /tmp/ci-marketplace-video origin/dev" >&2
      return 1
    }
    return 0
  fi

  # Find the CI-Marketplace CLONE the same way video/make.sh finds the kit:
  # CI_WORKSPACE if set, else WALK UP. `$root/../CI-Marketplace` is the
  # sibling-directory guess, and it is wrong in exactly the case this stage is
  # most often run from — a git worktree, whose parent is a scratch directory
  # holding only the repos someone happened to check out. Measured: the first
  # real run of this stage died on "no CI-Marketplace beside this repo" from a
  # worktree that had a perfectly good clone two levels up.
  local wt="$STAGE_DATA_DIR/marketplace" src=""
  if [ -n "${CI_WORKSPACE:-}" ] && [ -d "$CI_WORKSPACE/CI-Marketplace/.git" ]; then
    src="$CI_WORKSPACE/CI-Marketplace"
  else
    local d="$root"
    while [ "$d" != "/" ]; do
      if [ -d "$d/CI-Marketplace/.git" ]; then src="$d/CI-Marketplace"; break; fi
      d="$(dirname "$d")"
    done
  fi
  [ -n "$src" ] || {
    echo "stage: no CI-Marketplace clone found above $root (and CI_MARKETPLACE_DIR is unset)." >&2
    echo "       e2e/start-backend.sh symlinks its apps/ into the Hub's store; without it" >&2
    echo "       app-details, install-dialog and hub-home's tiles render empty." >&2
    return 1
  }
  if [ ! -d "$wt" ]; then
    local def; def="$(git -C "$src" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
    git -C "$src" fetch --quiet origin || true
    git -C "$src" worktree add --detach "$wt" "origin/${def:-dev}" >>"$STAGE_LOG" 2>&1 \
      || { echo "stage: could not create a CI-Marketplace worktree at $wt" >&2; return 1; }
  fi
  STAGE_OWNS_MARKETPLACE=1
  export CI_MARKETPLACE_DIR="$wt"
}

_stage_env() {
  local root="$1"
  export NODE_ENV=development E2E_TEST=true TZ=UTC
  export SERVER_IP=localhost
  export FRONTEND_PORT="$STAGE_WEB_PORT" BACKEND_PORT="$STAGE_API_PORT" API_PORT="$STAGE_API_PORT"
  export MOCK_PORTAL_PORT="$STAGE_PORTAL_PORT" CI_CLOUD_URL="http://localhost:$STAGE_PORTAL_PORT"
  export POSTGRES_HOST=localhost POSTGRES_PORT="$STAGE_PG_PORT" POSTGRES_USERNAME=companion
  export POSTGRES_PASSWORD=postgres POSTGRES_DBNAME=companiondb
  export RABBITMQ_HOST=localhost RABBITMQ_PORT="$STAGE_MQ_PORT" RABBITMQ_USERNAME=companion
  export RABBITMQ_PASSWORD=admin JWT_SECRET=e2e-test-secret
  export DEVICE_ID=test-device-e2e
  export CI_HUB_DATA_DIR="$STAGE_DATA_DIR"
  export CI_HUB_APP_DATA_DIR="$STAGE_DATA_DIR/app-data"
  export CI_HUB_APP_DATA_PATH="$STAGE_DATA_DIR"
  export CI_HUB_TUNNEL_DIR="$STAGE_DATA_DIR/tunnel"
  export ROOT_FOLDER_HOST="$STAGE_DATA_DIR" CI_HUB_APP_DIR="$root"
  export CI_HUB_FORWARD_AUTH_URL="http://localhost:$STAGE_API_PORT/api/auth/traefik"
  export MOCK_PORTAL_OPERATOR_EMAIL=owner@acme.com MOCK_PORTAL_OPERATOR_PASSWORD=password
}

stage_up() {
  local root; root="$(_stage_root)"
  command -v docker >/dev/null || { echo "stage: docker not found — this stage needs Postgres and RabbitMQ" >&2; return 1; }
  docker info >/dev/null 2>&1 || { echo "stage: docker is not running — 'colima start'" >&2; return 1; }

  # Clear a leaked stage before starting, and REFUSE if a port survives it. A
  # stage that inherits the previous run's backend captures the previous run's
  # code and says nothing — see the note above stage_down.
  stage_down
  for p in "$STAGE_WEB_PORT" "$STAGE_API_PORT" "$STAGE_PORTAL_PORT"; do
    port_is_free "$p" || die "port $p is still held after stage_down.
     Something from an earlier run — or another agent's stage — is on it, and
     capturing now would film that process rather than this checkout."
  done

  mkdir -p "$STAGE_DATA_DIR/app-data" "$STAGE_DATA_DIR/tunnel"
  _stage_env "$root"
  _stage_marketplace "$root"

  ( cd "$root" && corepack enable >/dev/null 2>&1 || true )
  ( cd "$root" && corepack pnpm install --frozen-lockfile ) >>"$STAGE_LOG" 2>&1

  docker rm -f "$STAGE_PG_NAME" "$STAGE_MQ_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$STAGE_PG_NAME" -p "$STAGE_PG_PORT:$STAGE_PG_PORT" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=companion -e POSTGRES_DB=companiondb \
    postgres:14 -p "$STAGE_PG_PORT" >>"$STAGE_LOG" 2>&1
  docker run -d --name "$STAGE_MQ_NAME" -p "$STAGE_MQ_PORT:5672" \
    -e RABBITMQ_DEFAULT_USER=companion -e RABBITMQ_DEFAULT_PASS=admin \
    rabbitmq:4-alpine >>"$STAGE_LOG" 2>&1

  ( cd "$root" && nohup env MOCK_PORTAL_SCENARIO=registered \
      corepack pnpm exec tsx e2e/mock-portal/server.ts >>"$STAGE_LOG" 2>&1 </dev/null & disown ) 2>/dev/null || true
  _stage_wait_http "http://localhost:$STAGE_PORTAL_PORT/" "mock portal"

  # Backend FIRST and to completion-of-boot, because it builds @ci-hub/common
  # partway through — see the race warning at the top of this file.
  ( cd "$root" && nohup bash e2e/start-backend.sh >>"$STAGE_LOG" 2>&1 </dev/null & disown ) 2>/dev/null || true
  _stage_wait_http "http://localhost:$STAGE_API_PORT/api/health" "backend"

  grep -q "CI-Marketplace: linked" "$STAGE_LOG" \
    || echo "stage: WARNING — no 'CI-Marketplace: linked' in the backend log; store shots may render empty" >&2

  # Only now build the frontend, so it compiles against the common the backend
  # just built rather than the previous commit's dist.
  ( cd "$root" && corepack pnpm run --filter @ci-hub/common build ) >>"$STAGE_LOG" 2>&1
  ( cd "$root" && corepack pnpm run --filter frontend build )        >>"$STAGE_LOG" 2>&1

  # The mtime assertion the README tells a human to eyeball. A frontend older
  # than common is the silent failure: plausible shots, exit 0, check passes.
  local common_dist="$root/packages/common/dist/schemas/dynamic-compose.js"
  local front_dist="$root/packages/frontend/dist/client/index.html"
  if [ -f "$common_dist" ] && [ -f "$front_dist" ]; then
    [ "$front_dist" -nt "$common_dist" ] || {
      echo "stage: the frontend bundle is OLDER than @ci-hub/common — it was built against a stale dist." >&2
      echo "       Capturing now would film a bundle that is not this tree, and nothing else would say so." >&2
      return 1
    }
  fi

  ( cd "$root" && nohup corepack pnpm run --filter frontend preview \
      >>"$STAGE_LOG" 2>&1 </dev/null & disown ) 2>/dev/null || true
  _stage_wait_http "http://localhost:$STAGE_WEB_PORT/" "frontend preview"

  ( cd "$root" && corepack pnpm exec tsx video/stage/seed.mts ) >>"$STAGE_LOG" 2>&1
}

# ── the shoot ────────────────────────────────────────────────────────────────
# Two passes, because onboarding-wizard needs a state the other eight cannot be
# shot in. make.sh calls this INSTEAD of a single `kit capture` — and never when
# --only is given, so re-shooting one shot does not re-run the whole sequence.
capture_all() {
  local root; root="$(_stage_root)"

  # Pass 1. Re-seed immediately before, and take hub-home first — the
  # five-minute sync_app_statuses cron badges every app logo red otherwise.
  say "pass 1/2 — re-seeding, then the eight signed-in shots (hub-home first)"
  ( cd "$root" && corepack pnpm exec tsx video/stage/seed.mts ) >>"$STAGE_LOG" 2>&1
  kit capture --only hub-home
  kit capture --only ai-hardware,ai-models,install-dialog,port-expose,store-alternatives,app-hermes,app-openclaw

  # Pass 2. Un-onboard, shoot the wizard, then put the Hub back: an un-onboarded
  # operator changes what /home and /login do for anything shot afterwards.
  say "pass 2/2 — arming the first-boot wizard"
  ( cd "$root" && corepack pnpm exec tsx video/stage/arm-onboarding.mts ) >>"$STAGE_LOG" 2>&1
  kit capture --only onboarding-wizard
  ( cd "$root" && RESTORE=1 corepack pnpm exec tsx video/stage/arm-onboarding.mts ) >>"$STAGE_LOG" 2>&1
}

# ── tearing down, by PORT ────────────────────────────────────────────────────
# Naming the command that was LAUNCHED is not enough, because the thing holding
# the port is often a grandchild with a different command line. `start-backend.sh`
# ends up running `node dist/src/main.js`; killing the script leaves the server.
#
# Measured, and it is the failure this whole pipeline is about: a second run
# began at 20:13:04 and captured against a backend that had started at 20:09:19 —
# the PREVIOUS run's. Both runs were the same tree, so nothing looked wrong. Edit
# code between two runs and the second one films the old bundle, `capture` exits
# 0, `check` passes, and the shots are plausible and wrong.
#
# So: kill by command where that is precise, then sweep whatever still holds each
# port. The port is what makes a process ours — these are the video stage's own
# 919x band, not the Hub's defaults — so this cannot reach another agent's stage.
#
# `|| pid=""` on every lookup is not defensive noise — it is required. `lsof`
# exits 1 when nothing matches, and under `set -o pipefail` that status survives
# `| head -1` and becomes the assignment's status, which `set -e` then treats as
# a fatal error. The symptom is the worst kind: stage_up died INSIDE stage_down
# with no message at all, printing "starting the stage" and then "stopping the
# stage" — a stage that appeared to decline to run for no reason. Found by
# tracing, because there was nothing to read.
_port_pid() { lsof -tnP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true; }

_kill_port() {
  local pid
  for _ in 1 2 3 4 5 6; do
    pid="$(_port_pid "$1")" || pid=""
    [ -n "$pid" ] || return 0
    kill "$pid" 2>/dev/null || true
    sleep 1
  done
  pid="$(_port_pid "$1")" || pid=""
  [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
  return 0
}

stage_down() {
  pkill -f "tsx e2e/mock-portal/server.ts" 2>/dev/null || true
  pkill -f "start-backend.sh"              2>/dev/null || true
  pkill -f "filter frontend preview"       2>/dev/null || true
  _kill_port "$STAGE_WEB_PORT"
  _kill_port "$STAGE_API_PORT"
  _kill_port "$STAGE_PORTAL_PORT"
  docker rm -f "$STAGE_PG_NAME" "$STAGE_MQ_NAME" >/dev/null 2>&1 || true
  # Only a worktree this script created. One the operator supplied is theirs.
  if [ "$STAGE_OWNS_MARKETPLACE" = 1 ] && [ -n "${CI_MARKETPLACE_DIR:-}" ]; then
    git -C "$(_stage_root)/../CI-Marketplace" worktree remove --force "$CI_MARKETPLACE_DIR" >/dev/null 2>&1 || true
  fi
  return 0
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  # STANDALONE USE NEEDS THE HELPERS make.sh NORMALLY SUPPLIES. When this file is
  # sourced by the runner, say/warn/die/port_is_free/pick_port/kit are already
  # defined; run directly, they are not — and stage_up calls port_is_free and die
  # before it does anything else, so `./video/stage.sh up` died on
  # "port_is_free: command not found". The header documents this entry point, so
  # it has to work.
  command -v say          >/dev/null 2>&1 || say()  { printf "\n==> %s\n" "$*"; }
  command -v warn         >/dev/null 2>&1 || warn() { printf " ! %s\n" "$*" >&2; }
  command -v die          >/dev/null 2>&1 || die()  { printf "\n x %s\n" "$*" >&2; exit 1; }
  command -v port_is_free >/dev/null 2>&1 || port_is_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
  case "${1:-up}" in
    up)   stage_up; echo "stage up — APP_URL=$APP_URL (log: $STAGE_LOG)" ;;
    down) stage_down; echo "stage down" ;;
    *)    echo "usage: $0 [up|down]" >&2; exit 2 ;;
  esac
fi
