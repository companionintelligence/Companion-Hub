#!/usr/bin/env bash
# Integration test: Real device registration against the dev Portal.
# Prerequisites:
# - The Hub is running and reachable at HUB_URL.
# - The Portal is reachable at PORTAL_URL.
# - Docker access is available for the ci-os-hub and related containers used below.
set -euo pipefail

PORTAL_URL="https://hub.companionintelligence.com"
HUB_URL="http://localhost:5002"
TIMESTAMP=$(date +%s)
PASS_CHARS='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%'

# Track test artifacts for teardown — each entry is "email|password|org_id|device_id"
declare -a TEARDOWN_ENTRIES=()

generate_password() {
  head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9!@#' | head -c 20
  echo '1Aa!'  # ensure complexity requirements
}

log() { echo -e "\n=== $1 ==="; }
ok()  { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; exit 1; }

# ── Teardown: clean up Portal artifacts ────────────────────────────────────
# Best-effort: errors here must not mask the real test outcome.
teardown_portal_artifacts() {
  [ ${#TEARDOWN_ENTRIES[@]} -eq 0 ] && return 0

  log "Tearing down Portal test artifacts"

  for entry in "${TEARDOWN_ENTRIES[@]}"; do
    IFS='|' read -r t_email t_password t_org_id t_device_id <<< "$entry"

    local jar
    jar=$(mktemp)

    # Sign in
    if ! curl -sf -X POST "$PORTAL_URL/api/auth/sign-in/email" \
        -H "Content-Type: application/json" \
        -H "Origin: $PORTAL_URL" \
        -c "$jar" \
        -d "{\"email\":\"$t_email\",\"password\":\"$t_password\"}" > /dev/null 2>&1; then
      echo "  ⚠️  Could not sign in as $t_email for cleanup"
      rm -f "$jar"
      continue
    fi

    # Set active org so membership checks pass
    curl -sf -X POST "$PORTAL_URL/api/auth/organization/set-active" \
      -H "Content-Type: application/json" \
      -H "Origin: $PORTAL_URL" \
      -b "$jar" -c "$jar" \
      -d "{\"organizationId\":\"$t_org_id\"}" > /dev/null 2>&1 || true

    # Delete device (cleans up Cloudflare tunnel + DNS)
    if [ -n "$t_device_id" ]; then
      local http_code
      http_code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
        "$PORTAL_URL/api/devices/$t_device_id" \
        -H "Origin: $PORTAL_URL" \
        -b "$jar" 2>/dev/null) || http_code="000"
      if [ "$http_code" = "200" ] || [ "$http_code" = "207" ]; then
        ok "Deleted device $t_device_id"
      else
        echo "  ⚠️  Delete device $t_device_id returned HTTP $http_code"
      fi
    fi

    # Delete organization (now that device is removed)
    if [ -n "$t_org_id" ]; then
      local http_code
      http_code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
        "$PORTAL_URL/api/organization/$t_org_id" \
        -H "Origin: $PORTAL_URL" \
        -b "$jar" 2>/dev/null) || http_code="000"
      if [ "$http_code" = "200" ]; then
        ok "Deleted organization $t_org_id"
      else
        echo "  ⚠️  Delete organization $t_org_id returned HTTP $http_code"
      fi
    fi

    rm -f "$jar"
  done
}

# Always run teardown on exit (success or failure)
trap teardown_portal_artifacts EXIT

# ── Preflight ──────────────────────────────────────────────────────────────
log "Preflight checks"

curl -sf "$HUB_URL/api/health" > /dev/null || fail "Hub not healthy at $HUB_URL"
ok "Hub healthy"

curl -sf "$PORTAL_URL/api/health" > /dev/null || fail "Portal not reachable at $PORTAL_URL"
ok "Portal reachable"

# ── Reset Hub to unregistered state ────────────────────────────────────────
reset_hub() {
  log "Resetting Hub to unregistered state"
  
  # Stop cloudflared if running
  docker rm -f cloudflared 2>/dev/null && ok "Removed cloudflared container" || ok "No cloudflared to remove"
  
  # Clear tunnel token
  docker exec ci-os-hub rm -f /app/tunnel/token 2>/dev/null && ok "Removed tunnel token" || ok "No tunnel token to remove"
  
  # Wipe registration from DB
  docker exec ci-os-hub node -e "
    const { Client } = require('pg');
    const c = new Client({
      host: process.env.POSTGRES_HOST || 'ci-hub-db',
      port: parseInt(process.env.POSTGRES_PORT || '6543'),
      user: process.env.POSTGRES_USERNAME || 'companion',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DBNAME || 'companiondb',
    });
    c.connect().then(() => 
      c.query('DELETE FROM device_registration')
    ).then(r => {
      console.log('Deleted ' + r.rowCount + ' registration rows');
      return c.end();
    }).catch(e => { console.error(e.message); process.exit(1); });
  " 2>&1
  ok "Wiped device_registration table"
  
  # Restart Hub container to pick up clean state
  docker restart ci-os-hub 2>&1 | tail -1
  ok "Restarted ci-os-hub"
  
  # Wait for healthy
  for i in $(seq 1 60); do
    if curl -sf "$HUB_URL/api/health" > /dev/null 2>&1; then
      ok "Hub healthy after restart (${i}s)"
      break
    fi
    [ "$i" -eq 60 ] && fail "Hub didn't become healthy after restart"
    sleep 1
  done
  
  # Verify unregistered
  STATUS=$(curl -sf "$HUB_URL/api/registration/status" 2>&1)
  echo "$STATUS" | grep -q '"registered":false' || fail "Hub still registered after reset: $STATUS"
  ok "Hub is unregistered"
}

# ── Portal signup + device creation ────────────────────────────────────────
# Returns: sets PAIRING_CODE variable
create_portal_account_and_device() {
  local EMAIL="$1"
  local PASSWORD="$2"
  local ORG_NAME="$3"
  local DEVICE_NAME="$4"
  
  log "Creating Portal account: $EMAIL"
  
  # Sign up — capture cookies
  COOKIE_JAR=$(mktemp)
  SIGNUP_RESP=$(curl -sf -X POST "$PORTAL_URL/api/auth/sign-up/email" \
    -H "Content-Type: application/json" \
    -H "Origin: $PORTAL_URL" \
    -c "$COOKIE_JAR" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"E2E Test\"}" 2>&1) || {
    echo "Signup response: $SIGNUP_RESP"
    # May fail if account exists — try sign in
    SIGNUP_RESP=$(curl -sf -X POST "$PORTAL_URL/api/auth/sign-in/email" \
      -H "Content-Type: application/json" \
      -H "Origin: $PORTAL_URL" \
      -c "$COOKIE_JAR" \
      -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" 2>&1) || fail "Both signup and signin failed: $SIGNUP_RESP"
    ok "Signed in to existing account"
  }
  ok "Portal account ready"
  
  # Read cookies for subsequent requests
  COOKIES=$(cat "$COOKIE_JAR" | grep -v '^#' | awk '{print $6"="$7}' | tr '\n' '; ')
  
  # Create organization
  local ORG_SLUG=$(echo "$ORG_NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')
  ORG_RESP=$(curl -sf -X POST "$PORTAL_URL/api/auth/organization/create" \
    -H "Content-Type: application/json" \
    -H "Origin: $PORTAL_URL" \
    -b "$COOKIE_JAR" \
    -c "$COOKIE_JAR" \
    -d "{\"name\":\"$ORG_NAME\",\"slug\":\"$ORG_SLUG\"}" 2>&1) || fail "Create org failed: $ORG_RESP"
  
  # Extract org ID — try multiple JSON shapes
  ORG_ID=$(echo "$ORG_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
# better-auth may nest under 'data' or return directly
o = d.get('data', d) if isinstance(d.get('data'), dict) else d
print(o.get('id', ''))
" 2>/dev/null) || fail "Failed to parse org response: $ORG_RESP"
  [ -n "$ORG_ID" ] || fail "No org ID in response: $ORG_RESP"
  ok "Created org: $ORG_ID"
  
  # Set active org
  curl -sf -X POST "$PORTAL_URL/api/auth/organization/set-active" \
    -H "Content-Type: application/json" \
    -H "Origin: $PORTAL_URL" \
    -b "$COOKIE_JAR" \
    -c "$COOKIE_JAR" \
    -d "{\"organizationId\":\"$ORG_ID\"}" > /dev/null 2>&1 || fail "Set active org failed"
  ok "Set active org"
  
  # Create device
  DEVICE_RESP=$(curl -sf -X POST "$PORTAL_URL/api/devices" \
    -H "Content-Type: application/json" \
    -H "Origin: $PORTAL_URL" \
    -b "$COOKIE_JAR" \
    -c "$COOKIE_JAR" \
    -d "{\"name\":\"$DEVICE_NAME\",\"organization_id\":\"$ORG_ID\"}" 2>&1) || fail "Create device failed: $DEVICE_RESP"
  
  PAIRING_CODE=$(echo "$DEVICE_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('pairingCode', d.get('pairing_code', '')))
" 2>/dev/null) || fail "Failed to parse device response: $DEVICE_RESP"
  [ -n "$PAIRING_CODE" ] && [ ${#PAIRING_CODE} -eq 6 ] || fail "Invalid pairing code '$PAIRING_CODE' from: $DEVICE_RESP"
  ok "Got pairing code: $PAIRING_CODE"
  
  DEVICE_ID=$(echo "$DEVICE_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('deviceId', d.get('device_id', '')))
" 2>/dev/null) || true
  [ -n "$DEVICE_ID" ] && ok "Got device ID: $DEVICE_ID" || echo "  ⚠️  Could not extract device ID (teardown may be incomplete)"
  
  rm -f "$COOKIE_JAR"
}

# ── Hub registration via API ──────────────────────────────────────────────
register_hub() {
  local CODE="$1"
  log "Registering Hub with pairing code: $CODE"
  
  PAIR_RESP=$(curl -sf -X POST "$HUB_URL/api/registration/pair" \
    -H "Content-Type: application/json" \
    -d "{\"pairing_code\":\"$CODE\"}" 2>&1) || fail "Pair request failed: $PAIR_RESP"
  
  echo "$PAIR_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('success'):
    print('  ✅ Pairing succeeded')
else:
    print('  ❌ Pairing failed: ' + json.dumps(d))
    sys.exit(1)
" || fail "Pair response indicates failure: $PAIR_RESP"
}

# ── Wait for registration + verify infrastructure ─────────────────────────
verify_registration() {
  log "Verifying registration and infrastructure"
  
  # Poll registration status
  REGISTERED=false
  for i in $(seq 1 60); do
    STATUS=$(curl -sf "$HUB_URL/api/registration/status" 2>&1)
    if echo "$STATUS" | grep -q '"registered":true'; then
      REGISTERED=true
      PHASE=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('phase','unknown'))" 2>/dev/null || echo "unknown")
      ok "Registered (phase: $PHASE) after ${i}s"
      break
    fi
    sleep 1
  done
  $REGISTERED || fail "Hub did not register within 60s. Last status: $STATUS"
  
  # Wait for cloudflared container to appear (fire-and-forget in Hub)
  CF_RUNNING=false
  for i in $(seq 1 30); do
    if docker ps --format '{{.Names}}' | grep -q '^cloudflared$'; then
      # Check it's actually running (not just Created)
      CF_STATUS=$(docker ps --format '{{.Status}}' --filter 'name=^cloudflared$')
      if echo "$CF_STATUS" | grep -q 'Up'; then
        CF_RUNNING=true
        ok "cloudflared container running: $CF_STATUS"
        break
      fi
    fi
    sleep 1
  done
  $CF_RUNNING || {
    echo "  ⚠️  cloudflared container status:"
    docker ps -a --filter 'name=cloudflared' --format '{{.Names}} {{.Status}}' 2>&1 || true
    fail "cloudflared not running within 30s"
  }
  
  # Verify tunnel token exists
  docker exec ci-os-hub test -f /app/tunnel/token && ok "Tunnel token file exists" || fail "No tunnel token file"
  TOKEN_LEN=$(docker exec ci-os-hub sh -c 'wc -c < /app/tunnel/token' 2>/dev/null || echo "0")
  TOKEN_LEN=$(echo "$TOKEN_LEN" | tr -d ' ')
  [ "$TOKEN_LEN" -gt 10 ] && ok "Tunnel token has content (${TOKEN_LEN} bytes)" || fail "Tunnel token too short: ${TOKEN_LEN} bytes"
  
  # Check cloudflared logs for connection (give it a few seconds)
  sleep 5
  CF_LOGS=$(docker logs cloudflared --tail 30 2>&1 || true)
  if echo "$CF_LOGS" | grep -qi "Registered tunnel connection\|INF.*connectionID\|Connection.*registered"; then
    ok "cloudflared connected to Cloudflare edge"
  elif echo "$CF_LOGS" | grep -qi "token\|error\|failed"; then
    echo "  ⚠️  cloudflared logs (may still be connecting):"
    echo "$CF_LOGS" | tail -5 | sed 's/^/    /'
    # Don't fail — tunnel may take time to establish
    echo "  ℹ️  Tunnel connection pending (not a test failure)"
  else
    echo "  ℹ️  cloudflared logs:"
    echo "$CF_LOGS" | tail -5 | sed 's/^/    /'
  fi
}

# ══════════════════════════════════════════════════════════════════════════
# MAIN TEST EXECUTION
# ══════════════════════════════════════════════════════════════════════════

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Integration Test: Real Device Registration (Dev Portal)    ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── Round 1: Fresh registration ────────────────────────────────────────────
EMAIL1="e2e-${TIMESTAMP}-r1@test.companionintelligence.com"
PASS1=$(generate_password)

reset_hub
create_portal_account_and_device "$EMAIL1" "$PASS1" "E2E Org R1 $TIMESTAMP" "E2E Hub R1"
TEARDOWN_ENTRIES+=("$EMAIL1|$PASS1|$ORG_ID|$DEVICE_ID")
register_hub "$PAIRING_CODE"
verify_registration

log "Round 1 complete ✅"
echo "  Account: $EMAIL1"
echo "  Pairing code: $PAIRING_CODE"

# ── Round 2: Re-registration with different account ────────────────────────
EMAIL2="e2e-${TIMESTAMP}-r2@test.companionintelligence.com"
PASS2=$(generate_password)

reset_hub
create_portal_account_and_device "$EMAIL2" "$PASS2" "E2E Org R2 $TIMESTAMP" "E2E Hub R2"
TEARDOWN_ENTRIES+=("$EMAIL2|$PASS2|$ORG_ID|$DEVICE_ID")
register_hub "$PAIRING_CODE"
verify_registration

log "Round 2 complete ✅"
echo "  Account: $EMAIL2"
echo "  Pairing code: $PAIRING_CODE"

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ALL TESTS PASSED ✅                                        ║"
echo "║                                                              ║"
echo "║  Round 1: Fresh registration                                 ║"
echo "║  Round 2: Re-registration (different Portal account)         ║"
echo "╚══════════════════════════════════════════════════════════════╝"
