#!/bin/sh
# Unit-tests docker-entrypoint.sh's config-readability rule.
#
# Why this rule has a test: getting it wrong is what takes a node out of service. A
# container that runs as a uid which cannot read /data/.env dies on EACCES every few
# seconds, and the error names a path the operator never chose while saying nothing about
# the uid that is actually the cause. That happened on a fleet node moved from an older
# root-running image onto one that drops privileges.
#
# The drop path only executes as root, so the script is sourced as a library
# (CI_HUB_ENTRYPOINT_LIB=1) and the rule is called directly. Real files with real modes —
# no stubbed stat — with the caller uid varied, which covers the whole truth table without
# needing root.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ENTRY="$HERE/../../docker-entrypoint.sh"
PASS=0; FAIL=0

# shellcheck disable=SC1090
CI_HUB_ENTRYPOINT_LIB=1 . "$ENTRY"
# The entrypoint sets -eu for its own execution; sourcing it applies that here too, and
# -e would abort this script on the first case that is SUPPOSED to fail.
set +e

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
ME_UID=$(id -u); ME_GID=$(id -g)

mk() { f="$WORK/env.$1"; printf 'X=1\n' > "$f"; chmod "$1" "$f"; printf '%s' "$f"; }
try() { out=$( { assert_config_readable "$1" "$2" "$3"; } 2>&1 ); rc=$?; }
check() {
  if [ "$rc" = "$2" ] && { [ -z "${3:-}" ] || printf '%s' "$out" | grep -q "$3"; }; then
    PASS=$((PASS+1)); echo "  ok   $1"
  else
    FAIL=$((FAIL+1)); echo "  FAIL $1 (rc=$rc want=$2)"; printf '%s\n' "$out" | sed 's/^/       /'
  fi
}

echo "entrypoint config-readability rule"

P600=$(mk 600); P644=$(mk 644); P640=$(mk 640)

# THE BUG: 0600 owned by someone else, dropping to a different uid.
try 31337 31337 "$P600"
check "0600 config + foreign uid refuses" 1 "refusing to start"
check "  and names the CI_HUB_CONTAINER_UID=0 remedy" 1 "CI_HUB_CONTAINER_UID=0"
check "  and names the chown alternative" 1 "chown -R 31337"

# The owner can read its own 0600 file — a user-owned install must keep working.
try "$ME_UID" "$ME_GID" "$P600"
check "0600 config + owning uid allowed" 0

# root reads anything.
try 0 0 "$P600"
check "uid 0 allowed regardless of mode" 0

# world-readable is fine for anyone.
try 31337 31337 "$P644"
check "0644 config + foreign uid allowed" 0

# group-readable is honoured via the gid, not just the uid.
try 31337 "$ME_GID" "$P640"
check "0640 config + matching gid allowed" 0
try 31337 31337 "$P640"
check "0640 config + foreign uid and gid refuses" 1 "refusing to start"

# A fresh install has no .env yet; the rule must not block boot.
try 31337 31337 "$WORK/does-not-exist"
check "absent config does not block boot" 0

# The uid DERIVATION, exercised the way COMPOSE actually delivers it.
#
# The previous version of this test called the derivation with the variable UNSET and
# passed — while in production it was dead code, because every compose file rendered
# `CI_HUB_CONTAINER_UID: ${CI_HUB_CONTAINER_UID:-1000}`, so the variable was ALWAYS set,
# to 1000. A root-owned install therefore still dropped to 1000 and crash-looped on its
# own 0600 /data/.env. The test was right about the script and silent about the contract.
#
# So model the contract: compose renders `${VAR:-}` as the EMPTY STRING (not an omitted
# key), and the image's BusyBox sh treats empty as unset for `${VAR:-default}`. Both are
# verified against the shipped image; if either stopped holding, the derivation would
# silently stop working again exactly as it did before.
derive() { # data_owner_uid  compose_rendered_value  -> the HUB_UID actually used
  DATA_UID="$1" CI_HUB_CONTAINER_UID="$2" sh -c 'printf %s "${CI_HUB_CONTAINER_UID:-${DATA_UID:-1000}}"'
}

# What compose sends after this fix: the empty string.
[ "$(derive 0 '')" = "0" ] && { PASS=$((PASS+1)); echo "  ok   root-owned + empty passthrough derives 0 (skips the drop)"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL root-owned + empty passthrough should derive 0, got $(derive 0 '')"; }
[ "$(derive 1000 '')" = "1000" ] && { PASS=$((PASS+1)); echo "  ok   user-owned + empty passthrough derives 1000"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL user-owned should derive 1000, got $(derive 1000 '')"; }

# THE REGRESSION GUARD: what compose sent BEFORE the fix. If someone reinstates a
# `:-1000` default in any compose file, the derivation goes dead again and a root-owned
# install crash-loops. This asserts that shape produces the WRONG answer, so the test
# fails loudly rather than the fleet doing it.
[ "$(derive 0 '1000')" = "1000" ] && { PASS=$((PASS+1)); echo "  ok   a compose :-1000 default provably defeats derivation (guarding against its return)"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL expected a 1000 default to defeat derivation"; }

# An explicit value still wins — the desktop app sets 0:0 on Windows deliberately.
[ "$(derive 1000 '0')" = "0" ] && { PASS=$((PASS+1)); echo "  ok   an explicit value still overrides the data-dir owner"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL explicit value should win, got $(derive 1000 '0')"; }

# Unreadable /data: fall back rather than emitting an empty uid.
[ "$(derive '' '')" = "1000" ] && { PASS=$((PASS+1)); echo "  ok   unreadable data dir falls back to 1000"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL missing data dir should fall back to 1000, got $(derive '' '')"; }

# THE SIGNAL ITSELF. The first version of this derivation stat'd /data, which is not a
# bind mount: compose mounts the install as individual subpaths (/data/.env, /data/state,
# ...), so Docker synthesises /data inside the container and owns it as root. Measured on
# 15 running fleet Hubs, `stat -c %u /data` was 0 on every one — including plain uid-1000
# installs — while the owner of /data/.env matched the uid each Hub actually ran as, every
# time. Reading /data would have dropped every node to root the moment the variable went
# unset. This asserts the entrypoint reads a bind-mounted path instead.
if grep -qE '^[[:space:]]*for _probe in /data/\.env' "$ENTRY"; then
  PASS=$((PASS+1)); echo "  ok   derivation reads a bind-mounted path, not the synthesised /data"
else
  FAIL=$((FAIL+1)); echo "  FAIL derivation must stat a bind-mounted path (/data/.env), not /data"
fi
if grep -qE 'stat -c %u /data 2>/dev/null' "$ENTRY"; then
  FAIL=$((FAIL+1)); echo "  FAIL entrypoint still stats /data, which is root-owned on every node"
else
  PASS=$((PASS+1)); echo "  ok   entrypoint no longer stats the synthesised /data"
fi

# And the contract the fix rests on: no compose file may reinstate a numeric default for
# the ENVIRONMENT passthrough. `user:` in docker-compose.local.yml is exempt — an empty
# value there renders the unparseable `user: ":"`, and a pinned user means the entrypoint
# never runs as root to derive anything in the first place.
REPO="$HERE/../.."
BAD=$(grep -rn 'CI_HUB_CONTAINER_UID: *${CI_HUB_CONTAINER_UID:-[0-9]' "$REPO"/docker-compose*.yml "$REPO"/packages/desktop/src-tauri/resources/docker-compose*.yml 2>/dev/null || true)
if [ -z "$BAD" ]; then
  PASS=$((PASS+1)); echo "  ok   no compose file defaults the env passthrough back to a number"
else
  FAIL=$((FAIL+1)); echo "  FAIL a compose file reinstated a numeric default:"; printf '%s\n' "$BAD" | sed 's/^/       /'
fi

echo "  ${PASS} passed, ${FAIL} failed"
[ "$FAIL" = "0" ]
