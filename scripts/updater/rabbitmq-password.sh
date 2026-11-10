# shellcheck shell=bash
# Broker password steps for scripts/updater/update.sh, which sources this file (Companion-Hub#884).
#
# The prod compose requires RABBITMQ_PASSWORD from the env file (newer copies) or falls back to
# `admin` (older ones), and the Hub warns on `admin` in production. update.sh gives the env file a
# password of its own before compose reads it, then checks the broker accepts the password compose
# hands the Hub.
#
# The password never appears in a process's arguments: `printf` is a shell builtin, and rabbitmqctl
# reads the password from stdin when the argument is left out (checked against rabbitmq:4-alpine,
# rabbitmqctl 4.4.0).
#
# Every function returns non-zero on a failure; update.sh runs under errexit, so that stops it.

# The last value of the variable $2 in the env file $1, unquoted. Empty when there is none.
# Fails when the file cannot be read (grep exit 2), rather than reading as "no value".
rabbitmq_password_env_value() {
  local lines rc=0
  lines="$(grep -E "^$2=" "$1")" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "ERROR: could not read $1" >&2
    return 1
  fi
  printf '%s\n' "$lines" | tail -n 1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# "uid gid mode" of the file $1 (mode in octal, e.g. 600), on GNU or BSD stat.
rabbitmq_password_file_stat() {
  stat -c '%u %g %a' "$1" 2>/dev/null || stat -f '%u %g %Lp' "$1"
}

# The mode the rewritten env file gets, from its owner uid $1, its mode $2 (octal) and the env file $3.
#
# Same rule as restrictEnvFileMode (scripts/env-file.ts): clear the group and other bits, never add
# any, except when CI_HUB_CONTAINER_UID pins the Hub to a non-root uid other than the file's owner.
# The Hub then reads the file as that uid through its group or other bits (docker-entrypoint.sh), so
# the mode stays as it was. The pinned uid comes from the exported environment first, then the env
# file, as compose reads it.
rabbitmq_password_target_mode() {
  local owner="$1" mode="$2" env_file="$3" pinned
  pinned="${CI_HUB_CONTAINER_UID:-}"
  if [ -z "$pinned" ]; then
    pinned="$(rabbitmq_password_env_value "$env_file" CI_HUB_CONTAINER_UID)" || return 1
  fi
  pinned="$(printf '%s' "$pinned" | tr -d '[:space:]')"
  if [ -n "$pinned" ] && [ "$pinned" != 0 ] && [ "$pinned" != "$owner" ]; then
    printf '%s\n' "$mode"
  else
    printf '%o\n' $((8#$mode & 8#600))
  fi
}

rabbitmq_password_cleanup_tmp() {
  if [ -n "${RABBITMQ_PASSWORD_TMP:-}" ]; then rm -f "$RABBITMQ_PASSWORD_TMP"; fi
  RABBITMQ_PASSWORD_TMP=""
}

# Replace RABBITMQ_PASSWORD in the env file $1 with $2, keeping the file's owner and group.
#
# The new content goes to a temp file beside it, which takes the original owner and group before the
# rename: run under sudo on a user-owned install, a plain rename would leave the file root:root, which
# changes the Hub's uid detection and locks the desktop app out of its own file. Nothing replaces the
# env file until every step has worked, and the traps (set before the temp file exists) remove the
# temp file if the script stops early.
rabbitmq_password_write() {
  local env_file="$1" password="$2" owner group mode target_mode rc=0
  read -r owner group mode < <(rabbitmq_password_file_stat "$env_file")
  if [ -z "${mode:-}" ]; then
    echo "ERROR: could not read the owner and mode of ${env_file}; it was left as it was."
    return 1
  fi
  target_mode="$(rabbitmq_password_target_mode "$owner" "$mode" "$env_file")" || return 1

  RABBITMQ_PASSWORD_TMP=""
  trap 'rabbitmq_password_cleanup_tmp' EXIT
  trap 'rabbitmq_password_cleanup_tmp; exit 130' INT
  trap 'rabbitmq_password_cleanup_tmp; exit 143' TERM
  RABBITMQ_PASSWORD_TMP="$(mktemp "${env_file}.XXXXXX")"
  chmod 600 "$RABBITMQ_PASSWORD_TMP"

  grep -vE '^RABBITMQ_PASSWORD=' "$env_file" > "$RABBITMQ_PASSWORD_TMP" || rc=$?
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
}

# The RABBITMQ_PASSWORD a running Hub container was created with, from `docker inspect`.
rabbitmq_password_of_container() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | grep -E '^RABBITMQ_PASSWORD=' | tail -n 1 | cut -d= -f2- || true
}

# Before compose reads the env file $1: make sure it has a RABBITMQ_PASSWORD other than `admin`.
# The value written is, in order: an exported RABBITMQ_PASSWORD (compose prefers it over the env
# file), the running Hub's own password (the broker already accepts it), or 32 random bytes in hex,
# skipping `admin` each time. $2 is the Hub container name. Sets RABBITMQ_PASSWORD_WRITTEN=yes on a
# write. A missing env file with no exported RABBITMQ_PASSWORD, an unreadable one, or a symlink stops
# the update.
rabbitmq_password_prepare() {
  local env_file="$1" hub="$2" current candidate="" source="" name
  RABBITMQ_PASSWORD_WRITTEN=""
  if [ -L "$env_file" ]; then
    echo "ERROR: ${env_file} is a symlink. Point update.sh at the file it links to (ENV_FILE), so the"
    echo "       broker password is written there instead of replacing the link with a copy."
    return 1
  fi
  if [ ! -f "$env_file" ]; then
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
  if [ -n "${RABBITMQ_PASSWORD:-}" ] && [ "${RABBITMQ_PASSWORD}" != "admin" ]; then
    candidate="$RABBITMQ_PASSWORD"
    source="the exported RABBITMQ_PASSWORD"
  else
    for name in "$hub" ci-hub ci-os-hub; do
      candidate="$(rabbitmq_password_of_container "$name")"
      [ -n "$candidate" ] && break
    done
    if [ -n "$candidate" ] && [ "$candidate" != "admin" ]; then
      source="the password the running Hub uses"
    else
      candidate="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
      source="a new random password"
    fi
  fi
  rabbitmq_password_write "$env_file" "$candidate"
  # shellcheck disable=SC2034 # read by the caller and by scripts/__tests__/updater-rabbitmq-password.test.ts
  RABBITMQ_PASSWORD_WRITTEN="yes"
  echo "   OK: RABBITMQ_PASSWORD was missing or the shared default 'admin' in ${env_file}; wrote ${source}"
}

# rabbitmqctl <verb> companion, with the password on stdin.
rabbitmq_password_ctl() {
  printf '%s' "$3" | docker exec -i "$1" rabbitmqctl "$2" companion > /dev/null 2>&1
}

# After `up`: check the broker accepts the password compose handed the Hub (an exported
# RABBITMQ_PASSWORD, else the env file's), on every run, so a run interrupted after the write heals
# on the next one. The broker applies RABBITMQ_DEFAULT_PASS only to a node database it creates; a
# recreated broker container gets a new hostname and so a new database. When it still refuses the
# password, change it in place and restart the Hub onto it.
# $1 env file, $2 Hub container, $3 seconds to wait for the broker to come up.
rabbitmq_password_check_broker() {
  local env_file="$1" hub="$2" timeout="$3" password="" queue="" name waited=0
  if [ -n "${RABBITMQ_PASSWORD:-}" ]; then
    password="$RABBITMQ_PASSWORD"
  elif [ -f "$env_file" ]; then
    password="$(rabbitmq_password_env_value "$env_file" RABBITMQ_PASSWORD)" || return 1
  fi
  [ -n "$password" ] || return 0
  for name in ci-hub-queue ci-os-hub-queue; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" = "true" ]; then
      queue="$name"
      break
    fi
  done
  if [ -z "$queue" ]; then
    echo "   WARNING: no running broker container (ci-hub-queue) to check RABBITMQ_PASSWORD against"
    return 0
  fi
  until docker exec "$queue" rabbitmq-diagnostics -q check_running > /dev/null 2>&1; do
    if [ "$waited" -ge "$timeout" ]; then
      echo "ERROR: broker not ready: ${queue} did not come up within ${timeout}s, so its password could not be checked."
      echo "       Check: docker logs ${queue} --tail 50"
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  if rabbitmq_password_ctl "$queue" authenticate_user "$password"; then
    echo "   OK: ${queue} accepts the broker password the Hub uses"
  elif rabbitmq_password_ctl "$queue" change_password "$password" && rabbitmq_password_ctl "$queue" authenticate_user "$password"; then
    echo "   OK: changed the broker password in ${queue} to the one the Hub uses; restarting ${hub}"
    docker restart "$hub" > /dev/null
  else
    echo "ERROR: ${queue} does not accept the broker password the Hub uses, and changing it failed."
    echo "       Recreate the broker: docker compose ... up -d --force-recreate ci-hub-queue"
    return 1
  fi
}
