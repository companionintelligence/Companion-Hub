#!/bin/sh
# Hub container entrypoint.
#
# Docker creates missing bind-mount source directories owned by root. The Hub
# process runs unprivileged (CI_HUB_CONTAINER_UID), so a root-owned /app/tunnel
# makes it impossible to write the Cloudflare tunnel token (EACCES) and the
# device gets stuck in the `tunnel_token_missing` degraded state. To make this
# self-heal on every start regardless of who created the dir, the container now
# starts as root, fixes ownership here, then drops to the Hub uid/gid — replacing
# the old compose `user:` directive.
set -eu

# The default is DERIVED from the install's own files, not hardcoded.
#
# A hardcoded 1000 is wrong for a root-owned install. `/root/.local/share/companion-hub`
# — what you get when the Hub is installed as root — is root:root with the env file at
# 0600, so dropping to 1000 makes the very first read fail:
#
#   Error: EACCES: permission denied, open '/data/.env'
#       at async generateSystemEnvFile (main.js) ... at async bootstrap
#
# and the container crash-loops with no hint that a uid is the problem. Observed on a
# fleet node whose older image predated this entrypoint: it had run happily as root for
# months, then failed the moment it was moved onto an image that drops privileges.
#
# Derived from a BIND-MOUNTED path, never from /data itself.
#
# /data is NOT a bind mount. The compose files mount the install's contents as individual
# subpaths — /data/.env, /data/state, /data/apps, and the rest — so /data is a directory
# Docker synthesises inside the container to hold them, and Docker creates it as root.
# Measured across the whole test fleet: `stat -c %u /data` returned 0 on all 15 running
# Hubs, on plain uid-1000 installs exactly as on root-owned ones. It is a constant, not a
# signal, and reading it would have dropped every node to root the moment the variable
# went unset.
#
# The bind-mounted config file DOES carry the install's identity, because it is the host's
# own file. Across those same 15 nodes its owner matched the uid each Hub was actually
# running as, every time: 1000 on the user installs, 1001 where the operator account is
# 1001, 0 on the three root-owned installs — the crash-loop case this default exists for.
#
# /data/state is the fallback for a first boot that has no env file yet; a literal 1000
# only if neither exists, which is the old behaviour.
DATA_UID=""
DATA_GID=""
for _probe in /data/.env /data/state; do
  if [ -e "$_probe" ]; then
    DATA_UID="$(stat -c %u "$_probe" 2>/dev/null || echo '')"
    DATA_GID="$(stat -c %g "$_probe" 2>/dev/null || echo '')"
    [ -n "$DATA_UID" ] && break
  fi
done
unset _probe

HUB_UID="${CI_HUB_CONTAINER_UID:-${DATA_UID:-1000}}"
HUB_GID="${CI_HUB_CONTAINER_GID:-${DATA_GID:-1000}}"
DOCKER_GID="${DOCKER_GID:-}"

# Refuse to run as a uid that cannot read the config, and SAY SO.
#
# Without this the failure surfaces as a bare EACCES on /data/.env from deep inside the
# bundle, repeated every few seconds forever. That names a path the operator never chose
# and says nothing about the cause, which is a uid mismatch between the container and the
# data directory. Diagnosing it took a fleet node out of service for the length of the
# investigation; the message below would have made it a thirty-second fix.
#
# Decided arithmetically from owner/group/mode rather than by running `test -r` as the
# target user: this image ships setpriv but NOT su-exec, so a check that shells out to a
# missing binary would fail OPEN — silently passing and guarding nothing, which is worse
# than no guard at all.
#
# Called on every path with the uid that path will really use, including the
# already-unprivileged one: a container whose compose still pins `user:` cannot drop, but
# it can still be pointed at config it cannot read, and it crash-loops identically.
assert_config_readable() { # uid gid [path]
  _uid=$1; _gid=$2; _path="${3:-/data/.env}"
  # Absent is fine: a fresh install has no .env until the Hub writes one.
  [ -f "$_path" ] || return 0
  _euid="$(stat -c %u "$_path" 2>/dev/null || echo '')"
  _egid="$(stat -c %g "$_path" 2>/dev/null || echo '')"
  _mode="$(stat -c %a "$_path" 2>/dev/null || echo '')"
  [ -n "$_mode" ] || return 0
  # Pad to 3 digits so "600" and "0600" compare the same.
  while [ "${#_mode}" -lt 3 ]; do _mode="0${_mode}"; done
  _mode="$(printf '%s' "$_mode" | tail -c 4)"
  _o="$(printf '%s' "$_mode" | cut -c1)"
  _g="$(printf '%s' "$_mode" | cut -c2)"
  _w="$(printf '%s' "$_mode" | cut -c3)"
  _ok=0
  case "$_w" in 4|5|6|7) _ok=1 ;; esac
  [ "$_uid" = "$_euid" ] && case "$_o" in 4|5|6|7) _ok=1 ;; esac
  [ "$_gid" = "$_egid" ] && case "$_g" in 4|5|6|7) _ok=1 ;; esac
  # uid 0 reads anything, mode notwithstanding.
  [ "$_uid" = "0" ] && _ok=1
  [ "$_ok" = "1" ] && return 0

  echo "ci-hub entrypoint: refusing to start." >&2
  echo "  ${_path} is owned by ${_euid}:${_egid} with mode ${_mode}, and this container will" >&2
  echo "  run as ${_uid}:${_gid}, which cannot read it. The Hub would crash-loop on EACCES" >&2
  echo "  with no explanation." >&2
  echo "" >&2
  echo "  For a root-owned install (data under /root), set both in the Hub .env:" >&2
  echo "      CI_HUB_CONTAINER_UID=0" >&2
  echo "      CI_HUB_CONTAINER_GID=0" >&2
  echo "  Otherwise make the data directory readable by ${_uid}:" >&2
  echo "      chown -R ${_uid}:${_gid} <data-dir>" >&2
  exit 1
}

# Sourced by test/entrypoint/run.sh to exercise assert_config_readable with controlled
# uid/gid pairs. The drop path only executes as root, so without this hook the one rule
# worth testing is the one that cannot be reached in CI.
if [ "${CI_HUB_ENTRYPOINT_LIB:-}" = "1" ]; then
  return 0
fi

# Root mode (e.g. Windows / Docker Desktop, where NTFS bind mounts require root):
# run the command as-is without dropping privileges.
if [ "$HUB_UID" = "0" ]; then
  exec "$@"
fi

# If we are already running unprivileged (e.g. a compose that still pins `user:`),
# we can neither chown the bind mount nor setpriv-drop (both need root). Run the
# command as-is instead of crash-looping on a failed privilege drop.
if [ "$(id -u)" != "0" ]; then
  assert_config_readable "$(id -u)" "$(id -g)"
  exec "$@"
fi

# Heal the tunnel bind mount so the Hub uid can write the tunnel token.
# Best-effort — never block boot on a chown failure.
if [ -d /app/tunnel ]; then
  chown -R "$HUB_UID:$HUB_GID" /app/tunnel 2>/dev/null || true
fi

assert_config_readable "$HUB_UID" "$HUB_GID"

# Drop privileges to the Hub uid/gid. Docker-socket access for the dropped process
# comes solely from adding DOCKER_GID as a supplementary group here: setpriv REPLACES
# the supplementary set (so the compose `group_add` does NOT survive the drop, and
# su-exec would clear the groups for a numeric uid). DOCKER_GID is supplied via the
# container env (compose defaults it to 973); if it is somehow unset we clear groups
# rather than leak root's, which means the Hub would lack socket access until it is set.
if [ -n "$DOCKER_GID" ]; then
  exec setpriv --reuid="$HUB_UID" --regid="$HUB_GID" --groups="$DOCKER_GID" -- "$@"
fi
exec setpriv --reuid="$HUB_UID" --regid="$HUB_GID" --clear-groups -- "$@"
