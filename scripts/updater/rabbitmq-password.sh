# shellcheck shell=bash
# Broker password steps for scripts/updater/update.sh, which sources this file (Companion-Hub#884).
#
# The prod compose requires RABBITMQ_PASSWORD from the env file (newer copies) or falls back to
# `admin` (older ones), and the Hub warns on `admin` in production. update.sh gives the env file a
# password of its own before compose reads it, then checks the broker accepts it.
#
# The password never appears in a process's arguments: `printf` is a shell builtin, and rabbitmqctl
# reads the password from stdin when the argument is left out (checked against rabbitmq:4-alpine,
# rabbitmqctl 4.4.0).

# The last RABBITMQ_PASSWORD value in the env file named by $1, unquoted. Empty when there is none.
rabbitmq_password_in_file() {
  grep -E '^RABBITMQ_PASSWORD=' "$1" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true
}

# uid:gid of the file named by $1, on GNU or BSD stat.
rabbitmq_password_file_owner() {
  stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"
}

# Replace RABBITMQ_PASSWORD in the env file $1 with $2, keeping the file's owner, at mode 0600.
#
# The new content goes to a temp file beside it, which takes the original owner and group before the
# rename: run under sudo on a user-owned install, a plain rename would leave the file root:root, which
# changes the Hub's uid detection and locks the desktop app out of its own file. The trap removes the
# temp file if the script stops before the rename.
rabbitmq_password_write() {
  local env_file="$1" password="$2" owner
  owner="$(rabbitmq_password_file_owner "$env_file")"
  RABBITMQ_PASSWORD_TMP="$(mktemp "${env_file}.XXXXXX")"
  trap 'rm -f "${RABBITMQ_PASSWORD_TMP:-}"' EXIT
  trap 'rm -f "${RABBITMQ_PASSWORD_TMP:-}"; exit 130' INT
  trap 'rm -f "${RABBITMQ_PASSWORD_TMP:-}"; exit 143' TERM
  chmod 600 "$RABBITMQ_PASSWORD_TMP"
  { grep -vE '^RABBITMQ_PASSWORD=' "$env_file" || true; } > "$RABBITMQ_PASSWORD_TMP"
  printf 'RABBITMQ_PASSWORD=%s\n' "$password" >> "$RABBITMQ_PASSWORD_TMP"
  if [ "$(rabbitmq_password_file_owner "$RABBITMQ_PASSWORD_TMP")" != "$owner" ]; then
    chown "$owner" "$RABBITMQ_PASSWORD_TMP"
  fi
  mv -f "$RABBITMQ_PASSWORD_TMP" "$env_file"
  RABBITMQ_PASSWORD_TMP=""
  trap - EXIT INT TERM
}

# The RABBITMQ_PASSWORD a running Hub container was created with, from `docker inspect`.
rabbitmq_password_of_container() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | grep -E '^RABBITMQ_PASSWORD=' | tail -n 1 | cut -d= -f2- || true
}

# Before compose reads the env file $1: make sure it has a RABBITMQ_PASSWORD other than `admin`.
# Uses the running Hub's own password when that is strong (the broker already accepts it), else 32
# random bytes in hex. $2 is the Hub container name. Sets RABBITMQ_PASSWORD_WRITTEN=yes on a write.
# A missing env file with no exported RABBITMQ_PASSWORD stops the update.
rabbitmq_password_prepare() {
  local env_file="$1" hub="$2" current candidate name
  RABBITMQ_PASSWORD_WRITTEN=""
  if [ ! -f "$env_file" ]; then
    if [ -z "${RABBITMQ_PASSWORD:-}" ] || [ "${RABBITMQ_PASSWORD}" = "admin" ]; then
      echo "ERROR: ${env_file} does not exist and RABBITMQ_PASSWORD is not exported, so the Hub would start"
      echo "       without a broker password of its own. Set RABBITMQ_PASSWORD in the env file."
      return 1
    fi
    return 0
  fi
  current="$(rabbitmq_password_in_file "$env_file")"
  if [ -n "$current" ] && [ "$current" != "admin" ]; then
    echo "   OK: RABBITMQ_PASSWORD is set in ${env_file}"
    return 0
  fi
  candidate=""
  for name in "$hub" ci-hub ci-os-hub; do
    candidate="$(rabbitmq_password_of_container "$name")"
    [ -n "$candidate" ] && break
  done
  if [ -z "$candidate" ] || [ "$candidate" = "admin" ]; then
    candidate="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  fi
  rabbitmq_password_write "$env_file" "$candidate"
  # shellcheck disable=SC2034 # read by the caller and by scripts/__tests__/updater-rabbitmq-password.test.ts
  RABBITMQ_PASSWORD_WRITTEN="yes"
  echo "   OK: RABBITMQ_PASSWORD was missing or the shared default 'admin' in ${env_file}; wrote one of its own"
}

# rabbitmqctl <verb> companion, with the password on stdin.
rabbitmq_password_ctl() {
  printf '%s' "$3" | docker exec -i "$1" rabbitmqctl "$2" companion > /dev/null 2>&1
}

# After `up`: check the broker accepts the env file's password, on every run, so a run interrupted
# after the write heals on the next one. The broker applies RABBITMQ_DEFAULT_PASS only to a node
# database it creates; a recreated broker container gets a new hostname and so a new database. When
# it still refuses the password, change it in place and restart the Hub onto it.
# $1 env file, $2 Hub container, $3 seconds to wait for the broker.
rabbitmq_password_check_broker() {
  local env_file="$1" hub="$2" timeout="$3" password queue="" name waited=0
  password="$(rabbitmq_password_in_file "$env_file")"
  [ -n "$password" ] || password="${RABBITMQ_PASSWORD:-}"
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
  until docker exec "$queue" rabbitmq-diagnostics -q check_running > /dev/null 2>&1 || [ "$waited" -ge "$timeout" ]; do
    sleep 2
    waited=$((waited + 2))
  done
  if rabbitmq_password_ctl "$queue" authenticate_user "$password"; then
    echo "   OK: ${queue} accepts the RABBITMQ_PASSWORD in ${env_file}"
  elif rabbitmq_password_ctl "$queue" change_password "$password" && rabbitmq_password_ctl "$queue" authenticate_user "$password"; then
    echo "   OK: changed the broker password in ${queue} to match ${env_file}; restarting ${hub}"
    docker restart "$hub" > /dev/null
  else
    echo "ERROR: ${queue} does not accept the RABBITMQ_PASSWORD in ${env_file}, and changing it failed."
    echo "       Recreate the broker: docker compose ... up -d --force-recreate ci-hub-queue"
    return 1
  fi
}
