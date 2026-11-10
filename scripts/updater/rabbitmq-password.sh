# shellcheck shell=bash
# Broker password steps for scripts/updater/update.sh, which sources this file (Companion-Hub#884).
#
# The prod compose requires RABBITMQ_PASSWORD from the env file (newer copies) or falls back to
# `admin` (older ones), and the Hub warns on `admin` in production. update.sh gives the env file a
# password of its own before compose reads it, then checks the broker accepts the password compose
# handed the Hub.
#
# The password never appears in a process's arguments: `printf` is a shell builtin, and rabbitmqctl
# reads the password from stdin when the argument is left out (checked against rabbitmq:4-alpine,
# rabbitmqctl 4.4.0).
#
# Every function returns non-zero on a failure; update.sh runs under errexit, so that stops it.

# Seconds any one docker call here may take, where `timeout` exists. Every docker call in this file
# goes through rabbitmq_password_docker, so a paused container or a stuck daemon cannot hang update.sh.
RABBITMQ_PASSWORD_DOCKER_TIMEOUT=60

# The value of $2 in the env file $1, read the way compose reads it: leading whitespace and a leading
# `export ` are ignored, spaces may surround `=`, a quoted value ends at its closing quote, and an
# unquoted value ends before a ` #` comment. The last definition wins. Empty when there is none.
# Fails when the file cannot be read, rather than reading as "no value".
rabbitmq_password_env_value() {
  awk -v key="$2" '
    {
      line = $0
      sub(/\r$/, "", line)
      sub(/^[ \t]+/, "", line)
      if (line ~ /^export[ \t]+/) sub(/^export[ \t]+/, "", line)
      eq = index(line, "=")
      if (eq == 0) next
      name = substr(line, 1, eq - 1)
      sub(/[ \t]+$/, "", name)
      if (name != key) next
      value = substr(line, eq + 1)
      sub(/^[ \t]+/, "", value)
      first = substr(value, 1, 1)
      if (first == "\"" || first == "\047") {
        rest = substr(value, 2)
        close_at = index(rest, first)
        value = close_at ? substr(rest, 1, close_at - 1) : rest
      } else {
        if (match(value, /[ \t]#/)) value = substr(value, 1, RSTART - 1)
        sub(/[ \t]+$/, "", value)
      }
      found = value
    }
    END { printf "%s", found }
  ' "$1" || {
    echo "ERROR: could not read $1" >&2
    return 1
  }
}

# "uid gid mode" of the file $1 (mode in octal, e.g. 600), on GNU or BSD stat.
rabbitmq_password_file_stat() {
  stat -c '%u %g %a' "$1" 2>/dev/null || stat -f '%u %g %Lp' "$1"
}

# Why a docker call failed, from its exit status $1 and its output $2: a timeout from the wrapper
# (exit 124), or docker's own first line.
rabbitmq_password_docker_cause() {
  if [ "$1" = 124 ]; then
    printf 'timed out after %ss' "$RABBITMQ_PASSWORD_DOCKER_TIMEOUT"
  else
    printf 'docker exited %s: %s' "$1" "$(printf '%s\n' "$2" | head -n 1)"
  fi
}

# Is the docker output $1 docker saying the container does not exist?
rabbitmq_password_docker_says_absent() {
  case "$1" in *"No such"*) return 0 ;; *) return 1 ;; esac
}

# The first of the Hub container names that exists: $1, then ci-hub, then ci-os-hub, on stdout.
# Empty when docker says none of them exists. When docker cannot answer (a timeout, or any error that
# is not "No such ..."), prints an ERROR and fails: "could not check" is never read as "absent".
rabbitmq_password_hub_container() {
  local name out rc
  for name in "$1" ci-hub ci-os-hub; do
    rc=0
    out="$(rabbitmq_password_docker inspect "$name" 2>&1)" || rc=$?
    if [ "$rc" = 0 ]; then
      printf '%s' "$name"
      return 0
    fi
    if ! rabbitmq_password_docker_says_absent "$out"; then
      echo "ERROR: could not check for the Hub container ${name} ($(rabbitmq_password_docker_cause "$rc" "$out"))." >&2
      return 1
    fi
  done
}

# The value of $2 in the environment compose gave the container $1, from `docker inspect`. Empty when
# the environment has no $2; a docker failure or timeout prints an ERROR and fails.
rabbitmq_password_container_env() {
  local out rc=0
  out="$(rabbitmq_password_docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>&1)" || rc=$?
  if [ "$rc" != 0 ]; then
    echo "ERROR: could not read the environment of $1 ($(rabbitmq_password_docker_cause "$rc" "$out"))." >&2
    return 1
  fi
  # Only the parsing may find nothing.
  printf '%s\n' "$out" | grep -E "^$2=" | tail -n 1 | cut -d= -f2- || true
}

# The RABBITMQ_PASSWORD a running Hub container was created with. A docker failure prints an ERROR and
# fails; a Hub whose environment has none prints a WARNING and gives an empty value.
rabbitmq_password_of_container() {
  local value
  value="$(rabbitmq_password_container_env "$1" RABBITMQ_PASSWORD)" || {
    echo "ERROR: could not read the Hub's broker password from $1." >&2
    return 1
  }
  if [ -z "$value" ]; then
    echo "   WARNING: the Hub container $1 has no RABBITMQ_PASSWORD in its environment." >&2
  fi
  printf '%s' "$value"
}

# The Config.User of the container $1. A docker failure or timeout prints an ERROR and fails.
rabbitmq_password_container_user() {
  local out rc=0
  out="$(rabbitmq_password_docker inspect -f '{{.Config.User}}' "$1" 2>&1)" || rc=$?
  if [ "$rc" != 0 ]; then
    echo "ERROR: could not read the user of $1 ($(rabbitmq_password_docker_cause "$rc" "$out"))." >&2
    return 1
  fi
  printf '%s' "$out"
}

# Is $1 a uid that pins the Hub to a non-root user other than the file owner $2?
rabbitmq_password_pins_other_uid() {
  local uid
  uid="$(printf '%s' "${1%%:*}" | tr -d '[:space:]')"
  [ -n "$uid" ] && [ "$uid" != 0 ] && [ "$uid" != root ] && [ "$uid" != "$2" ]
}

# The mode the rewritten env file gets, from its owner uid $1, its mode $2 (octal), the env file $3
# and the Hub container $4 (empty when none exists).
#
# Same rule as restrictEnvFileMode (scripts/env-file.ts): clear the group and other bits, never add
# any, except when the Hub is pinned to a non-root uid other than the file's owner. The Hub then reads
# the file as that uid through its group or other bits (docker-entrypoint.sh), so the mode stays as
# it was. Either pin keeps the mode: the running Hub's (its CI_HUB_CONTAINER_UID or Config.User), and
# the one the coming `up` gives it, which compose takes from an exported CI_HUB_CONTAINER_UID first,
# then from the env file (read as compose reads it). A Hub that cannot be read fails the rewrite:
# counting it as unpinned could narrow the file and lock a pinned Hub out of it.
rabbitmq_password_target_mode() {
  local owner="$1" mode="$2" env_file="$3" hub="$4" next_pin hub_pin="" hub_user=""
  next_pin="${CI_HUB_CONTAINER_UID:-}"
  if [ -z "$next_pin" ]; then
    next_pin="$(rabbitmq_password_env_value "$env_file" CI_HUB_CONTAINER_UID)" || return 1
  fi
  if [ -n "$hub" ]; then
    hub_pin="$(rabbitmq_password_container_env "$hub" CI_HUB_CONTAINER_UID)" || return 1
    hub_user="$(rabbitmq_password_container_user "$hub")" || return 1
  fi
  if rabbitmq_password_pins_other_uid "$next_pin" "$owner" \
    || rabbitmq_password_pins_other_uid "$hub_pin" "$owner" \
    || rabbitmq_password_pins_other_uid "$hub_user" "$owner"; then
    printf '%s\n' "$mode"
  else
    printf '%o\n' $((8#$mode & 8#600))
  fi
}

rabbitmq_password_cleanup_tmp() {
  if [ -n "${RABBITMQ_PASSWORD_TMP:-}" ]; then rm -f "$RABBITMQ_PASSWORD_TMP"; fi
  RABBITMQ_PASSWORD_TMP=""
}

# Replace RABBITMQ_PASSWORD in the env file $1 with $2, keeping the file's owner and group. $3 is the
# Hub container (empty when none exists).
#
# The new content goes to a temp file beside it, which takes the original owner and group before the
# rename: run under sudo on a user-owned install, a plain rename would leave the file root:root, which
# changes the Hub's uid detection and locks the desktop app out of its own file. Nothing replaces the
# env file until every step has worked, and the traps (set before the temp file exists) remove the
# temp file if the script stops early.
#
# These traps REPLACE any EXIT, INT or TERM trap the caller set, and are cleared (not restored)
# afterwards. update.sh sets none.
rabbitmq_password_write() {
  local env_file="$1" password="$2" hub="$3" owner group mode target_mode rc=0
  read -r owner group mode < <(rabbitmq_password_file_stat "$env_file")
  if [ -z "${mode:-}" ]; then
    echo "ERROR: could not read the owner and mode of ${env_file}; it was left as it was."
    return 1
  fi
  target_mode="$(rabbitmq_password_target_mode "$owner" "$mode" "$env_file" "$hub")" || {
    echo "ERROR: could not tell whether the Hub is pinned to another uid, so ${env_file} was left as it was."
    return 1
  }

  RABBITMQ_PASSWORD_TMP=""
  trap 'rabbitmq_password_cleanup_tmp' EXIT
  trap 'rabbitmq_password_cleanup_tmp; exit 130' INT
  trap 'rabbitmq_password_cleanup_tmp; exit 143' TERM
  RABBITMQ_PASSWORD_TMP="$(mktemp "${env_file}.XXXXXX")"
  chmod 600 "$RABBITMQ_PASSWORD_TMP"

  # Every form compose reads as RABBITMQ_PASSWORD goes, so the line written below is the only one.
  grep -vE '^[[:space:]]*(export[[:space:]]+)?RABBITMQ_PASSWORD[[:space:]]*=' "$env_file" > "$RABBITMQ_PASSWORD_TMP" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "ERROR: could not read ${env_file}; it was left as it was."
    rabbitmq_password_cleanup_tmp
    return 1
  fi
  printf 'RABBITMQ_PASSWORD=%s\n' "$password" >> "$RABBITMQ_PASSWORD_TMP"

  local tmp_owner tmp_group
  read -r tmp_owner tmp_group _ < <(rabbitmq_password_file_stat "$RABBITMQ_PASSWORD_TMP")
  if [ "$tmp_owner:$tmp_group" != "$owner:$group" ] && ! chown "$owner:$group" "$RABBITMQ_PASSWORD_TMP" 2>/dev/null; then
    echo "ERROR: could not give the rewritten ${env_file} its owner ${owner}:${group}; it was left as it was."
    echo "       Run update.sh as root (sudo), or as the user who owns ${env_file}."
    rabbitmq_password_cleanup_tmp
    return 1
  fi
  chmod "$target_mode" "$RABBITMQ_PASSWORD_TMP"
  mv -f "$RABBITMQ_PASSWORD_TMP" "$env_file"
  RABBITMQ_PASSWORD_TMP=""
  trap - EXIT INT TERM
  if [ "$target_mode" != "$mode" ]; then
    echo "   NOTE: ${env_file} mode changed from ${mode} to ${target_mode}"
  fi
}

# Before compose reads the env file $1: make sure it has a RABBITMQ_PASSWORD other than `admin`.
# The value written is, in order: an exported RABBITMQ_PASSWORD (compose prefers it over the env
# file), the running Hub's own password (the broker already accepts it), or 32 random bytes in hex,
# skipping `admin` each time. $2 is the Hub container name. Sets RABBITMQ_PASSWORD_WRITTEN=yes on a
# write. A missing env file with no exported RABBITMQ_PASSWORD, an unreadable one, or a symlink that
# would need rewriting stops the update.
rabbitmq_password_prepare() {
  local env_file="$1" hub current candidate="" source=""
  RABBITMQ_PASSWORD_WRITTEN=""
  if [ ! -e "$env_file" ]; then
    if [ -z "${RABBITMQ_PASSWORD:-}" ] || [ "${RABBITMQ_PASSWORD}" = "admin" ]; then
      echo "ERROR: ${env_file} does not exist and RABBITMQ_PASSWORD is not exported, so the Hub would start"
      echo "       without a broker password of its own. Set RABBITMQ_PASSWORD in the env file."
      return 1
    fi
    return 0
  fi
  current="$(rabbitmq_password_env_value "$env_file" RABBITMQ_PASSWORD)" || return 1
  if [ -n "$current" ] && [ "$current" != "admin" ]; then
    echo "   OK: RABBITMQ_PASSWORD is set in ${env_file}"
    return 0
  fi
  hub="$(rabbitmq_password_hub_container "$2")" || return 1
  if [ -n "${RABBITMQ_PASSWORD:-}" ] && [ "${RABBITMQ_PASSWORD}" != "admin" ]; then
    candidate="$RABBITMQ_PASSWORD"
    source="the exported RABBITMQ_PASSWORD"
  else
    if [ -n "$hub" ]; then candidate="$(rabbitmq_password_of_container "$hub")" || return 1; fi
    if [ -n "$candidate" ] && [ "$candidate" != "admin" ]; then
      source="the password the running Hub uses"
    else
      candidate="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
      source="a new random password"
    fi
  fi
  if [ -L "$env_file" ]; then
    echo "ERROR: ${env_file} is a symlink, and its RABBITMQ_PASSWORD is missing or 'admin'. Set a"
    echo "       RABBITMQ_PASSWORD of its own in the file the link points to, then run update.sh again."
    return 1
  fi
  rabbitmq_password_write "$env_file" "$candidate" "$hub"
  # shellcheck disable=SC2034 # read by rabbitmq_password_check_broker and by the tests
  RABBITMQ_PASSWORD_WRITTEN="yes"
  echo "   OK: RABBITMQ_PASSWORD was missing or the shared default 'admin' in ${env_file}; wrote ${source}"
}

# Run a docker command with RABBITMQ_PASSWORD_DOCKER_TIMEOUT, where `timeout` exists.
rabbitmq_password_docker() {
  if command -v timeout > /dev/null 2>&1; then
    timeout "$RABBITMQ_PASSWORD_DOCKER_TIMEOUT" docker "$@"
  else
    docker "$@"
  fi
}

# rabbitmqctl <verb> companion in the container $1, with the password $3 on stdin.
rabbitmq_password_ctl() {
  printf '%s' "$3" | rabbitmq_password_docker exec -i "$1" rabbitmqctl "$2" companion > /dev/null 2>&1
}

# Wait up to $2 seconds (wall clock) for the broker container $1 to report healthy, reading its
# health status as sync-rabbitmq-password.ts does rather than exec'ing into a broker that has just
# started. A container with no healthcheck counts once it runs.
rabbitmq_password_wait_for_broker() {
  local queue="$1" timeout="$2" started=$SECONDS status
  while :; do
    status="$(rabbitmq_password_docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$queue" 2>/dev/null || true)"
    case "$status" in healthy | none) return 0 ;; esac
    if [ $((SECONDS - started)) -ge "$timeout" ]; then return 1; fi
    sleep 2
  done
}

# After `up`: check the broker accepts the password compose gave the running Hub, on every run, so a
# run interrupted after the write heals on the next one. The value is read from the Hub container
# itself, never re-derived from the env file, so the broker is only ever changed to a password the
# Hub holds. With no Hub container, the env file's value (or an exported one) is checked but never
# set. A changed broker password, or an env file this run replaced (a rename gives it a new inode,
# and the Hub's bind mount keeps the old one), restarts the Hub.
# $1 env file, $2 Hub container, $3 seconds to wait for the broker to come up.
rabbitmq_password_check_broker() {
  local env_file="$1" timeout="$3" hub password="" queue="" name out rc restarted=""
  hub="$(rabbitmq_password_hub_container "$2")" || return 1
  if [ -n "$hub" ]; then
    password="$(rabbitmq_password_of_container "$hub")" || return 1
  elif [ -n "${RABBITMQ_PASSWORD:-}" ]; then
    password="$RABBITMQ_PASSWORD"
  elif [ -f "$env_file" ]; then
    password="$(rabbitmq_password_env_value "$env_file" RABBITMQ_PASSWORD)" || return 1
  fi
  for name in ci-hub-queue ci-os-hub-queue; do
    rc=0
    out="$(rabbitmq_password_docker inspect -f '{{.State.Running}}' "$name" 2>&1)" || rc=$?
    if [ "$rc" = 0 ] && [ "$out" = true ]; then
      queue="$name"
      break
    fi
    if [ "$rc" != 0 ] && ! rabbitmq_password_docker_says_absent "$out"; then
      echo "ERROR: the broker could not be checked: docker inspect ${name} failed ($(rabbitmq_password_docker_cause "$rc" "$out"))."
      return 1
    fi
  done
  if [ -n "$password" ] && [ -z "$queue" ]; then
    echo "   WARNING: no running broker container (ci-hub-queue) to check RABBITMQ_PASSWORD against"
  elif [ -n "$password" ]; then
    if ! rabbitmq_password_wait_for_broker "$queue" "$timeout"; then
      echo "ERROR: broker not ready: ${queue} did not report healthy within ${timeout}s, so its password could not be checked."
      echo "       Check: docker logs ${queue} --tail 50"
      return 1
    fi
    rc=0
    rabbitmq_password_ctl "$queue" authenticate_user "$password" || rc=$?
    if [ "$rc" = 124 ]; then
      echo "ERROR: the broker could not be checked: rabbitmqctl authenticate_user in ${queue} timed out."
      return 1
    elif [ "$rc" = 0 ]; then
      echo "   OK: ${queue} accepts the broker password the Hub uses"
    elif [ -z "$hub" ]; then
      echo "ERROR: ${queue} does not accept the broker password in ${env_file}, and there is no Hub container"
      echo "       to take the right one from, so the broker was left as it was."
      return 1
    else
      rc=0
      rabbitmq_password_ctl "$queue" change_password "$password" || rc=$?
      if [ "$rc" = 0 ]; then
        rabbitmq_password_ctl "$queue" authenticate_user "$password" || rc=$?
        if [ "$rc" = 124 ]; then
          echo "   WARNING: changed the broker password in ${queue}, but the check afterwards timed out, so the"
          echo "            change could not be confirmed. Check: docker logs ${queue} --tail 50"
          return 1
        fi
      elif [ "$rc" = 124 ]; then
        echo "   WARNING: rabbitmqctl change_password in ${queue} timed out, so the change could not be confirmed."
        return 1
      fi
      if [ "$rc" != 0 ]; then
        echo "ERROR: ${queue} does not accept the broker password the Hub uses, and changing it failed."
        echo "       Recreate the broker: docker compose ... up -d --force-recreate ci-hub-queue"
        return 1
      fi
      echo "   OK: changed the broker password in ${queue} to the one ${hub} uses; restarting ${hub}"
      rabbitmq_password_docker restart "$hub" > /dev/null || {
        echo "ERROR: docker restart ${hub} failed or timed out; it may still be restarting. Check: docker ps; docker logs ${hub} --tail 50" >&2
        return 1
      }
      restarted="yes"
    fi
  fi
  if [ "${RABBITMQ_PASSWORD_WRITTEN:-}" = yes ] && [ -n "$hub" ] && [ -z "$restarted" ]; then
    echo "   OK: restarting ${hub} so it reads the rewritten ${env_file}"
    rabbitmq_password_docker restart "$hub" > /dev/null || {
      echo "ERROR: docker restart ${hub} failed or timed out; it may still be restarting. Check: docker ps; docker logs ${hub} --tail 50" >&2
      return 1
    }
  fi
}
