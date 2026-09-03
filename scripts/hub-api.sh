#!/usr/bin/env bash
#
# hub-api.sh — auditable client for the live Hub, used by the fleet QA regression loop.
#
# ALL live-Hub interactions route through this one script so production access is a single
# allowlisted, reviewable surface (see .claude/settings.local.json permission rule).
# It reads credentials from the environment only — no secrets are hardcoded.
#
# Env:
#   HUB_URL        Hub base URL            (default: https://hub.ci.computer)
#   HUB_EMAIL      test-account email      (required for `login`)
#   HUB_PASSWORD   test-account password   (required for `login`)
#   HUB_COOKIE_JAR session cookie jar path (default: /tmp/hub-session.jar)
#
# Usage:
#   hub-api.sh login
#   hub-api.sh installed
#   hub-api.sh status   <urn>
#   hub-api.sh install  <urn>
#   hub-api.sh uninstall <urn>
#   hub-api.sh whoami
set -euo pipefail

COOKIE="${HUB_COOKIE_JAR:-/tmp/hub-session.jar}"

# Credentials come from the environment only (no secrets in the repo). Resolution order:
#   1) HUB_EMAIL/HUB_PASSWORD already exported
#   2) a local, untracked creds file (default /tmp/hub-fleet-creds.env) — keeps secrets
#      out of git and lets the invocation stay a clean, allowlistable `hub-api.sh ...`
#   3) TEST_EMAIL/TEST_PASSWORD from .env.e2e
CREDS_FILE="${HUB_CREDS_FILE:-/tmp/hub-fleet-creds.env}"
if [ -z "${HUB_EMAIL:-}" ] && [ -f "$CREDS_FILE" ]; then set -a; . "$CREDS_FILE"; set +a; fi
# HUB_URL default applied AFTER creds, so the creds file may point at a device Hub.
HUB_URL="${HUB_URL:-https://hub.ci.computer}"
ENV_FILE="${HUB_ENV_FILE:-$(dirname "$0")/../.env.e2e}"
if [ -z "${HUB_EMAIL:-}" ] && [ -f "$ENV_FILE" ]; then
  HUB_EMAIL="$(grep -E '^TEST_EMAIL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  HUB_PASSWORD="$(grep -E '^TEST_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  export HUB_EMAIL HUB_PASSWORD
fi

cmd="${1:-}"; shift || true

req() { curl -fsS -b "$COOKIE" "$@"; }

case "$cmd" in
  login)
    : "${HUB_EMAIL:?set HUB_EMAIL}"; : "${HUB_PASSWORD:?set HUB_PASSWORD}"
    python3 - "$HUB_URL" "$COOKIE" "$HUB_EMAIL" "$HUB_PASSWORD" <<'PY'
import sys, json, urllib.request, urllib.error, http.cookiejar
url, jar_path, email, password = sys.argv[1:5]
cj = http.cookiejar.MozillaCookieJar(jar_path)
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
body = json.dumps({"email": email, "password": password}).encode()
req = urllib.request.Request(f"{url}/api/auth/sign-in/email", data=body, headers={
    "content-type": "application/json",
    "origin": url,
    "referer": f"{url}/login",
    "user-agent": "ci-fleet-qa/1.0",
})
try:
    r = op.open(req, timeout=20)
    d = json.loads(r.read() or "{}")
    cj.save(ignore_discard=True)
    ok = bool(d.get("user") or d.get("token") or d.get("redirect"))
    print("login:", "ok" if ok else d)
except urllib.error.HTTPError as e:
    hdr = e.headers
    print(f"login FAILED: HTTP {e.code} {e.reason}")
    print(f"  server={hdr.get('server')} cf-ray={hdr.get('cf-ray')} content-type={hdr.get('content-type')}")
    print(f"  body={(e.read()[:400]).decode('utf-8','replace')}")
    sys.exit(1)
PY
    ;;
  whoami)    req "$HUB_URL/api/auth/me" 2>/dev/null || req "$HUB_URL/api/apps/installed" >/dev/null && echo "session ok" ;;
  probe)     curl -s -b "$COOKIE" -H "origin: $HUB_URL" -o /dev/null -w "%{http_code} %{content_type}\n" "$HUB_URL$1" ;;
  get)       curl -s -b "$COOKIE" -H "origin: $HUB_URL" "$HUB_URL$1" | head -c "${2:-600}"; echo ;;
  installed) req "$HUB_URL/api/apps/installed" ;;
  status)    req "$HUB_URL/api/apps/$1" ;;
  install)   req -X POST "$HUB_URL/api/app-lifecycle/$1/install" ;;
  uninstall) req -X DELETE "$HUB_URL/api/app-lifecycle/$1/uninstall" ;;
  *) echo "usage: hub-api.sh {login|whoami|installed|status <urn>|install <urn>|uninstall <urn>}" >&2; exit 2 ;;
esac
