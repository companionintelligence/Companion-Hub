#!/usr/bin/env bash
#
# smoke-boot-image.sh — boot a built Hub image the way a node does, and fail unless it comes up.
#
# Nothing else in CI runs the production bundle. Unit and integration tests run the TypeScript
# sources, and the image build only proves esbuild finished, so a bundle that cannot load a module
# at runtime passes every other check and then crash-loops on a fleet node. NestJS 12 did exactly
# that (`The "express" package is missing`, from ServeStaticModule); this is the check that would
# have caught it, and it also catches the boot failures a static look at the bundle cannot: assets
# missing from the image, a native module that does not load on Alpine, an entrypoint that cannot
# start the process, a migration that fails.
#
# It starts throwaway Postgres and RabbitMQ containers on a private network, runs the image through
# its real ENTRYPOINT and CMD (including the privilege drop to uid 1000, as on a node), and requires:
#   1. the Hub stays up, and /api/health/live and GET / both answer 200 from inside the container
#      (GET / is the bundled frontend, served by the very module that failed in the canary);
#   2. it is still up, and still answering, after a settle period that catches a late crash;
#   3. at every poll, no log line matches FATAL_LOG_RE.
# On failure it prints the Hub, broker and database logs and exits non-zero.
#
# Safe to run on a developer machine. No Docker socket is mounted and DOCKER_HOST names a path that
# does not exist, so the Hub cannot touch the host's Docker (it prunes networks at boot when it can
# reach one). CI_CLOUD_URL is a closed local port, so it cannot reach the real Portal either.
#
# Usage:
#   scripts/smoke-boot-image.sh <image>
#
# Env (all optional):
#   SMOKE_BOOT_TIMEOUT       seconds to wait for the Hub to become healthy        (default 240)
#   SMOKE_SETTLE_SECONDS     seconds it must then stay up and healthy             (default 15)
#   SMOKE_POSTGRES_IMAGE     default public.ecr.aws/docker/library/postgres:14
#   SMOKE_RABBITMQ_IMAGE     default public.ecr.aws/docker/library/rabbitmq:4-alpine
#   SMOKE_KEEP=1             leave containers, network and volumes behind for inspection
#   DOCKER_DEFAULT_PLATFORM  honoured by docker itself, e.g. linux/amd64
set -euo pipefail

IMAGE="${1:?usage: smoke-boot-image.sh <image>}"
BOOT_TIMEOUT="${SMOKE_BOOT_TIMEOUT:-240}"
SETTLE_SECONDS="${SMOKE_SETTLE_SECONDS:-15}"
POSTGRES_IMAGE="${SMOKE_POSTGRES_IMAGE:-public.ecr.aws/docker/library/postgres:14}"
RABBITMQ_IMAGE="${SMOKE_RABBITMQ_IMAGE:-public.ecr.aws/docker/library/rabbitmq:4-alpine}"

# A log line that means the bundle asked for a module the image does not have. `PackageLoader` is
# Nest's "The "<pkg>" package is missing" error, `Cannot find module` is a CommonJS require, and the
# last two are the ESM spellings (`Cannot find package 'x' imported from /app/main.js`).
FATAL_LOG_RE='PackageLoader|Cannot find (module|package)|MODULE_NOT_FOUND'

RUN_ID="hub-smoke-$$-$(date +%s)"
NETWORK="${RUN_ID}-net"
DB="${RUN_ID}-db"
MQ="${RUN_ID}-queue"
HUB="${RUN_ID}-hub"
DATA_VOLUME="${RUN_ID}-data"
APP_DATA_VOLUME="${RUN_ID}-app-data"

# Per-run credentials for containers that live for a minute and are never published. Random rather
# than a literal, because a production Hub refuses the broker's default password.
DB_PASSWORD="$(openssl rand -hex 12)"
MQ_PASSWORD="$(openssl rand -hex 12)"

# The data directories a Hub install creates on the host before compose up
# (scripts/init-hub-data-dirs.ts), plus the app-data mount.
DATA_DIRS="state cache apps repos logs backups media user-config .docker"

log() { printf '[smoke] %s\n' "$*"; }

# Collapsible sections in the Actions log; plain no-ops anywhere else.
group_start() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; fi; }
group_end() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }

now() { date +%s; }

fail() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::error title=Hub image failed its boot check::$*"
  fi
  printf '[smoke] FAIL: %s\n' "$*" >&2
  exit 1
}

dump_logs() {
  local name
  for name in "$HUB" "$MQ" "$DB"; do
    docker inspect "$name" >/dev/null 2>&1 || continue
    group_start "docker logs ${name#"${RUN_ID}"-}"
    docker logs --tail 400 "$name" 2>&1 || true
    group_end
  done
}

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    dump_logs
  fi
  if [ "${SMOKE_KEEP:-0}" = "1" ]; then
    log "SMOKE_KEEP=1: left ${HUB}, ${MQ}, ${DB}, ${NETWORK}, ${DATA_VOLUME} and ${APP_DATA_VOLUME} in place"
  else
    docker rm -f "$HUB" "$MQ" "$DB" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
    docker volume rm "$DATA_VOLUME" "$APP_DATA_VOLUME" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

# Wait for a command to succeed. wait_until <what> <timeout seconds> <command...>
wait_until() {
  local what="$1" timeout="$2" end
  shift 2
  end=$(($(now) + timeout))
  until "$@" >/dev/null 2>&1; do
    [ "$(now)" -lt "$end" ] || fail "${what} did not become ready within ${timeout}s"
    sleep 1
  done
}

docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "image ${IMAGE} is not available locally; build or pull it first"

# public.ecr.aws and Docker Hub both throttle anonymous pulls ("toomanyrequests"). That is a flake in
# the registry, not a verdict on the Hub image, so retry before giving up.
pull_with_retry() {
  local image="$1" attempt
  docker image inspect "$image" >/dev/null 2>&1 && return 0
  for attempt in 1 2 3; do
    docker pull -q "$image" >/dev/null 2>&1 && return 0
    log "pulling ${image} failed (attempt ${attempt}/3)"
    sleep $((attempt * 10))
  done
  fail "could not pull ${image}"
}
pull_with_retry "$POSTGRES_IMAGE"
pull_with_retry "$RABBITMQ_IMAGE"

log "Booting ${IMAGE} against ${POSTGRES_IMAGE} and ${RABBITMQ_IMAGE}"
docker network create "$NETWORK" >/dev/null

# Same settings as docker-compose.prod.yml: Postgres on 6543, and RabbitMQ without feature flags.
docker run -d --name "$DB" --network "$NETWORK" --network-alias smoke-db \
  -e POSTGRES_USER=companion -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB=companiondb \
  "$POSTGRES_IMAGE" -p 6543 >/dev/null
docker run -d --name "$MQ" --network "$NETWORK" --network-alias smoke-queue \
  -e RABBITMQ_DEFAULT_USER=companion -e RABBITMQ_DEFAULT_PASS="$MQ_PASSWORD" -e RABBITMQ_FEATURE_FLAGS= \
  "$RABBITMQ_IMAGE" >/dev/null

# Hand the data volumes to uid 1000 using the image under test, so no other image is pulled. The
# entrypoint then drops to the uid that owns /data/state, exactly as it does on a node.
docker run --rm --user 0 --entrypoint sh -e DATA_DIRS="$DATA_DIRS" \
  -v "${DATA_VOLUME}:/data" -v "${APP_DATA_VOLUME}:/app-data" "$IMAGE" \
  -c 'cd /data && mkdir -p $DATA_DIRS && chown -R 1000:1000 /data /app-data' \
  || fail "could not prepare the data volumes with ${IMAGE}"

log "Waiting for Postgres and RabbitMQ"
wait_until "Postgres" 60 docker exec "$DB" pg_isready -q -h 127.0.0.1 -p 6543 -U companion -d companiondb
# As the broker's own user: a root-run probe that lands before the server has written ~/.erlang.cookie
# creates it root-owned, and the server then dies with "eacces" reading it.
wait_until "RabbitMQ" 180 docker exec --user rabbitmq "$MQ" rabbitmq-diagnostics -q check_running

# The smallest environment the backend needs to boot (everything else is generated or defaulted by
# generateSystemEnvFile). NEST_VERBOSE=1 only makes Nest log "Nest application successfully started".
docker run -d --name "$HUB" --network "$NETWORK" \
  -v "${DATA_VOLUME}:/data" -v "${APP_DATA_VOLUME}:/app-data" \
  -e NODE_ENV=production \
  -e API_PORT=5002 \
  -e HOME=/data/user-config \
  -e CI_HUB_CONTAINER_UID=1000 -e CI_HUB_CONTAINER_GID=1000 \
  -e NEST_VERBOSE=1 \
  -e ROOT_FOLDER_HOST=/data \
  -e CI_CLOUD_URL=http://127.0.0.1:9 \
  -e CI_HUB_VERSION=0.0.0-smoke \
  -e INTERNAL_IP=127.0.0.1 \
  -e TZ=UTC \
  -e DOCKER_HOST=unix:///nonexistent/docker.sock \
  -e POSTGRES_HOST=smoke-db -e POSTGRES_PORT=6543 \
  -e POSTGRES_USERNAME=companion -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DBNAME=companiondb \
  -e RABBITMQ_HOST=smoke-queue -e RABBITMQ_PORT=5672 \
  -e RABBITMQ_USERNAME=companion -e RABBITMQ_PASSWORD="$MQ_PASSWORD" \
  "$IMAGE" >/dev/null

# HTTP status of GET <path> on the Hub, issued from inside its container (curl ships in the image;
# compose's own healthcheck uses it). 000 when nothing is listening yet.
http_status() {
  docker exec "$HUB" curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:5002$1" 2>/dev/null || true
}

# Fails when the Hub has logged a missing module or has exited. Called on every poll, so a crash is
# reported as soon as it happens rather than as a timeout. The log is checked first: a Hub that dies
# on a missing module has also exited, and the module is the part worth reading.
assert_running() {
  local status exit_code hits
  # `|| true`: grep exits 1 on no match, and head can SIGPIPE docker logs, either of which pipefail
  # would turn into a failure of the check itself.
  hits="$(docker logs "$HUB" 2>&1 | grep -E "$FATAL_LOG_RE" | head -5 || true)"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" >&2
    fail "the Hub logged a missing module (matched /${FATAL_LOG_RE}/, first lines above)"
  fi
  status="$(docker inspect -f '{{.State.Status}}' "$HUB")"
  if [ "$status" != "running" ]; then
    exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$HUB")"
    fail "the Hub container is ${status} (exit code ${exit_code}); it did not stay up"
  fi
}

log "Waiting up to ${BOOT_TIMEOUT}s for /api/health/live and / to answer 200"
started=$(now)
end=$((started + BOOT_TIMEOUT))
live=000
root=000
while :; do
  assert_running
  live="$(http_status /api/health/live)"
  root="$(http_status /)"
  [ "$live" = 200 ] && [ "$root" = 200 ] && break
  [ "$(now)" -lt "$end" ] || fail "the Hub was not healthy within ${BOOT_TIMEOUT}s (GET /api/health/live -> ${live}, GET / -> ${root})"
  sleep 2
done
log "Healthy after $(($(now) - started))s (GET /api/health/live -> ${live}, GET / -> ${root})"

log "Holding for ${SETTLE_SECONDS}s to catch a late crash"
settle_end=$(($(now) + SETTLE_SECONDS))
while [ "$(now)" -lt "$settle_end" ]; do
  assert_running
  sleep 1
done
assert_running
live="$(http_status /api/health/live)"
[ "$live" = 200 ] || fail "the Hub stopped answering during the settle period (GET /api/health/live -> ${live})"

if docker logs "$HUB" 2>&1 | grep -q 'Nest application successfully started'; then
  log "Nest logged 'Nest application successfully started'"
else
  log "note: Nest's 'successfully started' line was not seen; /api/health/live is the readiness signal"
fi
group_start "Hub log (last 40 lines)"
docker logs --tail 40 "$HUB" 2>&1 || true
group_end
log "PASS: ${IMAGE} booted, stayed up for ${SETTLE_SECONDS}s, and its log has no missing-module lines"
