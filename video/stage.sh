#!/usr/bin/env bash
#
# The capture stage for Companion Hub.
#
# Sourced by video/make.sh (the kit's runner), which expects stage_up and
# stage_down, and defines capture_all so each shot is taken in the pass its
# state needs.
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
# THE SHOT LIST IS READ FROM THE STORYBOARD, NOT KEPT HERE. capture_all asks the
# kit's own `shotsOf` which ids the rendered cut needs — the same function behind
# shotFileNames, the render gate and `make-videos --list` — so what this stage
# shoots and what the fleet counts cannot disagree. They did: capture_all used to
# carry the nine ids storyboard.json referenced when #1092 landed, and the
# acquisition rewrite (#1130) moved the cut out from under it. From then on
# make.sh re-shot four of the cut's five ids plus five parked library scenes, and
# never running-app, which the new cut had just started to use.
#
# STAGE_SHOTS=library shoots `shotsOfLibrary` instead: every shot the storyboard
# has a recipe for, parked scenes included, through the same passes. The cut is
# the default because nothing renders a parked shot, and re-shooting one only
# churns a PNG — four of the five that moved between two identical runs of #1092
# (app-hermes, app-openclaw, hub-home, install-dialog) are parked now. PNGs on
# disk with no scene in storyboard.json at all have no recipe; neither set, nor
# `--only`, can re-shoot them.
#
# What this file still owns is WHICH PASS a shot needs. Any id not named in
# capture_all's case statement is an ordinary signed-in shot. Four are not:
#
# hub-home MUST BE CAPTURED FIRST, IMMEDIATELY AFTER THE SEED. sync_app_statuses
# is a five-minute cron. It no longer empties the tile row — it now overlays a
# RED ERROR BADGE on each app logo, which is a frame that still renders, still
# passes check, and looks like three broken images on a contact sheet. Measured:
# a hub-home captured six minutes after the seed came back SSIM 0.9968 against
# the good frame. Small enough to skim past in a diff, fatal on screen.
#
# ONBOARDING IS ITS OWN PASS. onboarding-wizard drives the real /login form, and
# /login's clientLoader redirects a signed-in visitor to /home — so it only works
# from an un-onboarded state, which arm-onboarding.mts creates and then restores.
#
# running-app IS LAST, AFTER A REAL IMMICH INSTALL. Its caption promises a green
# Running pill, and a seeded `running` row cannot produce one: the pill drops to
# an amber "Initializing" whenever runtime health reports zero containers. So the
# stage installs Immich through the Hub's own API and waits for every container
# to be healthy. It is last because nothing undoes that install before
# stage_down, and it changes other frames: Immich's store page swaps Install for
# Open, which install-dialog waits on, and hub-home grows a fourth tile.
#
# That used to be why running-app was not shot AT ALL — install-dialog was in the
# cut and running-app was not, so the stage chose install-dialog. Ordering makes
# the choice unnecessary: in one run, every shot that needs Immich absent comes
# before the install, and running-app after it.
#
# device-registration IS REFUSED. It needs fresh-unregistered.mts, which destroys
# the seeded operator, and no pass here runs it. It has no scene today; if one is
# added, capture_all stops rather than film it signed in.
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
# running-app's Immich. The port is in the stage's own band and is not in the
# frame. The project name is DockerReadFacade.getComposeProjectName's for this
# URN — the same on EVERY Hub, which is why ownership below is decided by where
# the compose file lives, never by this name.
STAGE_IMMICH_URN="immich:ci-marketplace"
STAGE_IMMICH_PROJECT="immich_ci-marketplace"
STAGE_IMMICH_TIMEOUT="${STAGE_IMMICH_TIMEOUT:-1200}"
# How long each server gets to answer. The backend's clock includes
# start-backend.sh's own `nest build`, which fits in 180s on a quiet machine and
# did not, twice, at a load average of ~200 from other agents' work.
STAGE_WAIT_SECONDS="${STAGE_WAIT_SECONDS:-180}"

export APP_URL="${APP_URL:-http://localhost:$STAGE_WEB_PORT}"

_stage_wait() { # url, label
  for _ in $(seq 1 "$STAGE_WAIT_SECONDS"); do
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
# above burns its full budget (180 seconds by default) before declaring a running
# server dead.
# Measured on the first real run of this stage.
#
# The right question for readiness is whether anything spoke HTTP at all, which
# is what a status code being present means. `%{http_code}` is 000 when the
# connection itself failed and the real code otherwise.
_stage_wait_http() { # url, label
  for _ in $(seq 1 "$STAGE_WAIT_SECONDS"); do
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
# have no app info to render — four empty screens, discovered afterwards. It is
# also where the mock portal serves running-app's Immich install bundle from.
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

# ── which shots ──────────────────────────────────────────────────────────────
# Asked of the kit the runner resolved, so the answer is the one `check` and the
# render gate will count against — see the header. KIT_ROOT and KIT_NODE_FLAGS
# are the runner's: a registry install carries dist/capture.js (the package's
# `./capture` export); a CI-Common checkout has no dist/ and runs src/capture.ts
# under the same type-stripping flags the runner gives the CLI.
_stage_shot_ids() { # root, cut|library → one id per line, in storyboard order
  local root="$1" set="$2" mod
  [ -n "${KIT_ROOT:-}" ] || { echo "stage: KIT_ROOT is unset — capture_all runs under video/make.sh" >&2; return 1; }
  mod="$KIT_ROOT/dist/capture.js"
  [ -f "$mod" ] || mod="$KIT_ROOT/src/capture.ts"
  # shellcheck disable=SC2086,SC2016  # flags split as the runner splits them; the JS is meant literally
  STAGE_KIT_CAPTURE="$mod" STAGE_STORYBOARD="$root/video/storyboard.json" STAGE_SHOT_SET="$set" \
    node ${KIT_NODE_FLAGS:-} --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const { STAGE_KIT_CAPTURE: mod, STAGE_STORYBOARD: file, STAGE_SHOT_SET: set } = process.env;
      const name = set === "library" ? "shotsOfLibrary" : "shotsOf";
      const pick = (await import(pathToFileURL(mod).href))[name];
      if (typeof pick !== "function") {
        console.error(`stage: ${mod} exports no ${name} — this kit predates the cut/library split`);
        process.exit(1);
      }
      for (const shot of pick(JSON.parse(readFileSync(file, "utf8")))) console.log(shot.id);
    '
}

# ── running-app's Immich ─────────────────────────────────────────────────────
# A container is the stage's when its compose working dir is inside
# STAGE_DATA_DIR: the Hub writes each app's compose file under its own data dir,
# so that label says WHICH Hub installed it. The project name cannot — it is
# `immich_ci-marketplace` on every Hub, and a developer's own Hub on this Docker
# daemon would share it. Removing by project name would take theirs down too.
_stage_immich_containers() { # owned|foreign → container ids
  local want="$1" id wd phys owner
  phys="$(cd "$STAGE_DATA_DIR" 2>/dev/null && pwd -P)" || phys="$STAGE_DATA_DIR"
  for id in $(docker ps -aq --filter "label=com.docker.compose.project=$STAGE_IMMICH_PROJECT" 2>/dev/null); do
    wd="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$id" 2>/dev/null)" || wd=""
    case "$wd" in "$STAGE_DATA_DIR"/*|"$phys"/*) owner=owned ;; *) owner=foreign ;; esac
    [ "$owner" != "$want" ] || echo "$id"
  done
  return 0
}

_stage_immich_remove() {
  command -v docker >/dev/null 2>&1 || return 0
  local ids; ids="$(_stage_immich_containers owned)"
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086  # one id per word
  docker rm -f $ids >/dev/null 2>&1 || true
  # The network is named for the project too, so it goes only once no container
  # of that project is left anywhere — a foreign Immich may still be using it.
  [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$STAGE_IMMICH_PROJECT" 2>/dev/null)" ] && return 0
  docker network ls -q --filter "label=com.docker.compose.project=$STAGE_IMMICH_PROJECT" 2>/dev/null \
    | xargs docker network rm >/dev/null 2>&1 || true
  return 0
}

# One line of state, and success only when the pill will be green: the Hub says
# `running`, and every service the marketplace declares has a container that is
# running and healthy (or declares no healthcheck). `Up` is not enough — the
# README's manual recipe said so, and the server's healthcheck takes a minute
# after its container starts.
_stage_immich_state() { # jar, expected container count
  local status ready=0 total=0 id s
  status="$(curl -sS -m 5 -b "$1" "http://localhost:$STAGE_API_PORT/api/apps/$STAGE_IMMICH_URN" 2>/dev/null \
    | node -e 'let b="";process.stdin.on("data",(c)=>b+=c).on("end",()=>{try{console.log(JSON.parse(b).app?.status??"absent")}catch{console.log("unreadable")}})')" \
    || status="unreachable"
  for id in $(_stage_immich_containers owned); do
    total=$((total + 1))
    s="$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null)" || s=""
    case "$s" in running/healthy|running/none) ready=$((ready + 1)) ;; esac
  done
  echo "hub status $status, $ready/$2 containers healthy ($total present)"
  [ "$status" = running ] && [ "$ready" = "$2" ] && [ "$total" = "$2" ]
}

_stage_immich_install() {
  local jar="$STAGE_DATA_DIR/immich.jar" compose port code expected state waited=0 foreign
  compose="$CI_MARKETPLACE_DIR/apps/immich/docker-compose.json"
  [ -f "$compose" ] || die "no $compose — the mock portal serves Immich's install bundle from that checkout"

  foreign="$(_stage_immich_containers foreign)"
  [ -z "$foreign" ] || die "another Hub's Immich is on this Docker daemon ($(printf '%s\n' "$foreign" | paste -sd' ' -)).
     Its compose project is $STAGE_IMMICH_PROJECT, the name every Hub gives Immich,
     so installing here would take it over. Stop it, or point this stage at
     another Docker context, then re-run."

  # A fresh install, like a new Hub's. The stage's database is new every run and
  # has never heard of this Immich, so anything left from an earlier run is an
  # orphan — and its Postgres data dir was initialised with the PREVIOUS install's
  # random IMMICH_DB_PASSWORD, which this install would not know.
  _stage_immich_remove
  rm -rf "${CI_HUB_APP_DATA_DIR:?}/ci-marketplace/immich" \
    || die "could not clear the last run's Immich data under $CI_HUB_APP_DATA_DIR/ci-marketplace/immich
     (on Linux, files Immich's containers wrote are root-owned)"

  expected="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).services.length)' "$compose")"
  port="$(pick_port 9196)"

  code="$(curl -sS -o "$STAGE_DATA_DIR/immich-login.out" -w '%{http_code}' -c "$jar" \
    -X POST "http://localhost:$STAGE_API_PORT/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$MOCK_PORTAL_OPERATOR_EMAIL\",\"password\":\"$MOCK_PORTAL_OPERATOR_PASSWORD\"}")" || code=000
  case "$code" in 2??) ;; *) die "login for the Immich install answered $code: $(head -c 400 "$STAGE_DATA_DIR/immich-login.out" 2>/dev/null)" ;; esac

  # The body is the one the README's manual recipe used for the committed frame.
  code="$(curl -sS -o "$STAGE_DATA_DIR/immich-install.out" -w '%{http_code}' -b "$jar" \
    -X POST "http://localhost:$STAGE_API_PORT/api/app-lifecycle/$STAGE_IMMICH_URN/install" \
    -H 'Content-Type: application/json' -d "{\"port\":$port,\"exposedLocal\":false,\"exposed\":false}")" || code=000
  case "$code" in 2??) ;; *) die "the Immich install answered $code: $(head -c 400 "$STAGE_DATA_DIR/immich-install.out" 2>/dev/null)" ;; esac

  # The install is asynchronous and pulls four images for real, so the first run
  # on a machine takes minutes. Say where it is once a minute, not every poll.
  until state="$(_stage_immich_state "$jar" "$expected")"; do
    [ "$waited" -lt "$STAGE_IMMICH_TIMEOUT" ] || {
      docker ps -a --filter "label=com.docker.compose.project=$STAGE_IMMICH_PROJECT" \
        --format '  {{.Names}}  {{.Status}}' >&2 2>/dev/null || true
      tail -40 "$STAGE_LOG" >&2 || true
      die "Immich was not up after ${STAGE_IMMICH_TIMEOUT}s — $state.
     running-app would film an amber Initializing pill under a caption promising
     a green one. STAGE_IMMICH_TIMEOUT raises the wait for a slow first pull."
    }
    [ $((waited % 60)) -ne 0 ] || echo "stage: installing Immich — $state" >&2
    sleep 5
    waited=$((waited + 5))
  done
  echo "stage: Immich is up on :$port — $state" >&2
}

# ── the shoot ────────────────────────────────────────────────────────────────
# make.sh calls this INSTEAD of a single `kit capture` — and never when --only is
# given, so re-shooting one shot does not re-run the whole sequence (nor install
# Immich: `--only running-app` needs Immich already up on a --keep-up stage).
capture_all() {
  local root; root="$(_stage_root)"
  local set="${STAGE_SHOTS:-cut}" ids id first="" batch="" wizard="" immich=""
  case "$set" in
    cut|library) ;;
    *) die "STAGE_SHOTS=$set — it is 'cut' (the default) or 'library'" ;;
  esac
  ids="$(_stage_shot_ids "$root" "$set")" || die "could not read the storyboard's $set from the kit"
  [ -n "$ids" ] || die "storyboard.json's $set references no shots"

  # Sort every id into the pass its state needs BEFORE shooting anything, so a
  # refusal costs nothing. Unnamed ids keep storyboard order in the main batch.
  for id in $ids; do
    case "$id" in
      hub-home)            first="$id" ;;
      onboarding-wizard)   wizard="$id" ;;
      running-app)         immich="$id" ;;
      device-registration) die "device-registration is in the storyboard's $set, and this stage has no pass for it.
     It needs video/stage/fresh-unregistered.mts, which destroys the seeded
     operator, so it must be the very last pass — see video/README.md." ;;
      *)                   batch="${batch:+$batch,}$id" ;;
    esac
  done
  say "shooting the storyboard's $set: $(printf '%s\n' "$ids" | paste -sd, -)"

  # Signed-in shots. Re-seed immediately before, and give hub-home its own
  # `kit capture` so it really is first: one invocation shoots in storyboard
  # order, not --only order, and every desktop frame before any mobile one.
  say "signed-in pass — re-seeding${first:+, then $first alone}${batch:+, then $batch}"
  ( cd "$root" && corepack pnpm exec tsx video/stage/seed.mts ) >>"$STAGE_LOG" 2>&1
  if [ -n "$first" ]; then kit capture --only "$first"; fi
  if [ -n "$batch" ]; then kit capture --only "$batch"; fi

  # Un-onboard, shoot the wizard, then put the Hub back: an un-onboarded operator
  # changes what /home and /login do for anything shot afterwards.
  if [ -n "$wizard" ]; then
    say "onboarding pass — arming the first-boot wizard"
    ( cd "$root" && corepack pnpm exec tsx video/stage/arm-onboarding.mts ) >>"$STAGE_LOG" 2>&1
    kit capture --only "$wizard"
    ( cd "$root" && RESTORE=1 corepack pnpm exec tsx video/stage/arm-onboarding.mts ) >>"$STAGE_LOG" 2>&1
  fi

  # Last, because the install stays until stage_down — see the header.
  if [ -n "$immich" ]; then
    say "Immich pass — installing it for real, then $immich"
    _stage_immich_install
    kit capture --only "$immich"
  fi
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

# A killed start-backend.sh leaves its `nest build` running, and a build holds
# no port, so the sweep below cannot see it. Measured: the next stage_up's build
# raced a leaked one on packages/backend/dist and died on ENOTEMPTY, after which
# the stage waited out its whole budget on a backend that would never start.
# Only a build whose working directory is THIS checkout's backend is ours.
_stage_kill_builds() {
  local backend pid cwd
  backend="$(cd "$(_stage_root)/packages/backend" 2>/dev/null && pwd -P)" || return 0
  for pid in $(pgrep -f "nest build|nest.js build" 2>/dev/null); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" || cwd=""
    [ "$cwd" != "$backend" ] || kill "$pid" 2>/dev/null || true
  done
  return 0
}

stage_down() {
  pkill -f "tsx e2e/mock-portal/server.ts" 2>/dev/null || true
  pkill -f "start-backend.sh"              2>/dev/null || true
  pkill -f "filter frontend preview"       2>/dev/null || true
  _stage_kill_builds
  _kill_port "$STAGE_WEB_PORT"
  _kill_port "$STAGE_API_PORT"
  _kill_port "$STAGE_PORTAL_PORT"
  # After the backend is gone, so nothing is left to restart them. Only the
  # stage's own — see _stage_immich_containers.
  _stage_immich_remove
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
