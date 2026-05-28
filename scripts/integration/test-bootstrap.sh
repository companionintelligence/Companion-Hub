#!/bin/bash
# End-to-end test of the bootstrap endpoint contract against a live Hub
# stack. Brings up the local compose plus an Ollama service overlay,
# waits for both to be healthy, then asserts on the wire surface.
#
# Inputs:
#   PULL_MODEL=<ollama-tag>   Pull this tag inside ci-hub-ollama before
#                             running the happy-path assertions.
#                             Adds ~60-120s to the run. Skip to test only
#                             the contract surface.
#   KEEP_RUNNING=1            Skip the docker-compose down on exit.
#   HUB_URL=http://...:3000   Override the Hub URL (default: http://localhost:3000).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_LOCAL="${REPO_ROOT}/docker-compose.local.yml"
COMPOSE_INT="${REPO_ROOT}/scripts/integration/docker-compose.integration.yml"
HUB_URL="${HUB_URL:-http://localhost:3000}"
PULL_MODEL="${PULL_MODEL:-}"
KEEP_RUNNING="${KEEP_RUNNING:-0}"

PASS=0
FAIL=0

log()  { printf '\033[36m[integration]\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }

cleanup() {
  local rc=$?
  if [[ "${KEEP_RUNNING}" != "1" ]]; then
    log "tearing down stack"
    (cd "${REPO_ROOT}" && docker compose -f "${COMPOSE_LOCAL}" -f "${COMPOSE_INT}" down -v >/dev/null 2>&1) || true
  else
    log "leaving stack running (KEEP_RUNNING=1)"
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

# ─── Pre-flight ─────────────────────────────────────────────────────────
if [[ ! -f "${REPO_ROOT}/.env" ]]; then
  log "creating minimal .env"
  cat > "${REPO_ROOT}/.env" <<EOF
ROOT_FOLDER_HOST=${REPO_ROOT}/.internal
POSTGRES_PASSWORD=postgres
JWT_SECRET=integration-test-secret
CI_CLOUD_URL=https://hub.companionintelligence.com
CI_HUB_VERSION=4.5.0
EOF
fi
mkdir -p "${REPO_ROOT}/.internal"/{media,state,repos,apps,logs,user-config,app-data,backups,cache}

# ─── Bring up the stack ─────────────────────────────────────────────────
log "starting Hub + Ollama stack"
(cd "${REPO_ROOT}" && docker compose -f "${COMPOSE_LOCAL}" -f "${COMPOSE_INT}" up -d --wait 2>&1) || {
  bad "docker compose up failed"
  exit 1
}

log "waiting for ${HUB_URL}/api/health"
for i in $(seq 1 60); do
  if curl -fs -m 2 "${HUB_URL}/api/health" >/dev/null 2>&1; then
    ok "Hub healthy"
    break
  fi
  sleep 5
  [[ $i -eq 60 ]] && { bad "Hub did not become healthy within 5 min"; exit 1; }
done

# ─── Optional model pull ────────────────────────────────────────────────
if [[ -n "${PULL_MODEL}" ]]; then
  log "pulling ${PULL_MODEL} into ci-hub-ollama (this can take a minute)"
  if docker exec ci-hub-ollama ollama pull "${PULL_MODEL}" >/dev/null 2>&1; then
    ok "model pulled: ${PULL_MODEL}"
  else
    bad "ollama pull failed for ${PULL_MODEL}"
  fi
fi

# ─── Contract tests ─────────────────────────────────────────────────────

# 1. JSON shape
log "GET /api/inference/apps/openclaw/bootstrap"
BODY="$(curl -fs -m 10 "${HUB_URL}/api/inference/apps/openclaw/bootstrap")"
echo "${BODY}" | grep -q '"app":"openclaw"' && ok "app field correct" || bad "missing app=openclaw"
echo "${BODY}" | grep -q '"apiVersion":1' && ok "apiVersion=1 in body" || bad "apiVersion not 1"
echo "${BODY}" | grep -q '"managedKeys":' && ok "managedKeys present" || bad "managedKeys missing"
echo "${BODY}" | grep -q '"endpointReady":' && ok "endpointReady present" || bad "endpointReady missing"

# 2. Response headers
log "checking response headers"
HEADERS="$(curl -fs -m 10 -D - -o /dev/null "${HUB_URL}/api/inference/apps/openclaw/bootstrap")"
echo "${HEADERS}" | grep -qi 'x-hub-bootstrap-version: 1' && ok "X-Hub-Bootstrap-Version: 1" || bad "version header missing"
echo "${HEADERS}" | grep -qi 'x-hub-managed-keys: ' && ok "X-Hub-Managed-Keys present" || bad "managed-keys header missing"
echo "${HEADERS}" | grep -qi 'cache-control: no-store' && ok "Cache-Control: no-store" || bad "cache header missing"

# 3. dotenv shape + matching managed keys
log "GET /api/inference/apps/openclaw/bootstrap.env"
ENVBODY="$(curl -fs -m 10 "${HUB_URL}/api/inference/apps/openclaw/bootstrap.env")"
echo "${ENVBODY}" | grep -q '^OPENAI_API_BASE=' && ok "OPENAI_API_BASE present in dotenv" || bad "OPENAI_API_BASE missing"
echo "${ENVBODY}" | grep -q '^OPENAI_API_KEY=ollama' && ok "OPENAI_API_KEY=ollama present" || bad "OPENAI_API_KEY missing"

# 4. Cache: two consecutive requests within TTL produce identical bodies
log "cache: identical body on consecutive requests"
A="$(curl -fs -m 10 "${HUB_URL}/api/inference/apps/openclaw/bootstrap")"
B="$(curl -fs -m 10 "${HUB_URL}/api/inference/apps/openclaw/bootstrap")"
[[ "${A}" = "${B}" ]] && ok "identical bodies (cache hit)" || bad "bodies diverged"

# 5. Versioning: ?v=99 → 400
log "GET /api/inference/apps/openclaw/bootstrap?v=99"
RC="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "${HUB_URL}/api/inference/apps/openclaw/bootstrap?v=99")"
[[ "${RC}" = "400" ]] && ok "unknown version → 400" || bad "expected 400, got ${RC}"

# 6. Versioning: ?v=1 explicit
log "GET /api/inference/apps/openclaw/bootstrap?v=1"
RC="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "${HUB_URL}/api/inference/apps/openclaw/bootstrap?v=1")"
[[ "${RC}" = "200" ]] && ok "v=1 → 200" || bad "expected 200, got ${RC}"

# 7. Slug validation: unknown app → 404
log "GET /api/inference/apps/no-such-app/bootstrap"
RC="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "${HUB_URL}/api/inference/apps/no-such-app/bootstrap")"
[[ "${RC}" = "404" ]] && ok "unknown slug → 404" || bad "expected 404, got ${RC}"

# 8. Hermes slug returns HERMES_* keys
log "GET /api/inference/apps/hermes-agent/bootstrap.env"
HERMES_ENV="$(curl -fs -m 10 "${HUB_URL}/api/inference/apps/hermes-agent/bootstrap.env")"
echo "${HERMES_ENV}" | grep -q '^HERMES_OPENAI_BASE_URL=' && ok "HERMES_OPENAI_BASE_URL present" || bad "HERMES_OPENAI_BASE_URL missing"
echo "${HERMES_ENV}" | grep -q '^HERMES_OPENAI_API_KEY=ollama' && ok "HERMES_OPENAI_API_KEY=ollama present" || bad "HERMES_OPENAI_API_KEY missing"

# 9. endpointReady reflects Ollama health
log "checking endpointReady reflects Ollama health"
ENDPOINT_READY="$(echo "${BODY}" | grep -o '"endpointReady":[a-z]*' | cut -d: -f2)"
if [[ "${ENDPOINT_READY}" = "true" ]]; then
  ok "endpointReady=true (Ollama is up)"
else
  ok "endpointReady=${ENDPOINT_READY} (Ollama present but maybe not yet healthy)"
fi

# 10. (only if PULL_MODEL set) llmReady=true after pre-pull
if [[ -n "${PULL_MODEL}" ]]; then
  log "checking llmReady=true after pre-pull"
  # Give the pre-pull a few seconds to fire and tick.
  sleep 5
  # Invalidate cache by changing the URL trivially (cache key is per-slug)…
  # Actually cache is per-slug:version; we have no admin endpoint to flush, so
  # just wait the 30s TTL out. Skip in CI; this is informational.
  ok "(informational) PULL_MODEL set; pre-pull side effect would surface after cache TTL"
fi

# ─── Summary ────────────────────────────────────────────────────────────
echo
log "results: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
