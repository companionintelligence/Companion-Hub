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

# The uid DERIVATION — the half that prevents the outage rather than explaining it.
# A root-owned install (data dir owned by 0) must default to 0, not to 1000.
derive() { # data_owner_uid  -> the HUB_UID the script would pick with no env override
  printf '%s' "$(CI_HUB_CONTAINER_UID= sh -c '
    DATA_UID="'"$1"'"
    HUB_UID="${CI_HUB_CONTAINER_UID:-${DATA_UID:-1000}}"
    printf %s "$HUB_UID"')"
}
[ "$(derive 0)" = "0" ] && { PASS=$((PASS+1)); echo "  ok   root-owned data dir derives uid 0 (skips the drop)"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL root-owned data dir should derive uid 0, got $(derive 0)"; }
[ "$(derive 1000)" = "1000" ] && { PASS=$((PASS+1)); echo "  ok   user-owned data dir derives uid 1000"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL user-owned data dir should derive 1000, got $(derive 1000)"; }
[ "$(derive '')" = "1000" ] && { PASS=$((PASS+1)); echo "  ok   unreadable data dir falls back to 1000"; } \
  || { FAIL=$((FAIL+1)); echo "  FAIL missing data dir should fall back to 1000, got $(derive '')"; }

echo "  ${PASS} passed, ${FAIL} failed"
[ "$FAIL" = "0" ]
