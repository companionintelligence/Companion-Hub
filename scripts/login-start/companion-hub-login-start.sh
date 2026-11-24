#!/bin/sh
# Starts the Companion Hub containers that Docker could not start at boot because a
# bind-mounted file was not there yet, which happens when the home folder is unlocked at login
# (eCryptfs, fscrypt, systemd-homed). A container someone stopped is left alone.
#
# Run at each login by companion-hub-login-start.service. `cihub up` and the desktop app's
# headless mode (`companion-hub --detached`) install the same copy of this file; its source is
# scripts/login-start/companion-hub-login-start.sh in CI-Hub. Every exit is 0: a login with
# nothing to start, or no Docker, is normal and must not leave a failed unit behind.
set -u
log() { echo "companion-hub-login-start: $*"; }

i=0
until docker info >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    log "Docker did not answer within 120 s; started nothing"
    exit 0
  fi
  sleep 2
done

ids=$( {
  docker ps -aq --filter label=ci-hub.managed=true --filter status=exited
  docker ps -aq --filter label=ci-hub.managed=true --filter status=created
  docker ps -aq --filter label=com.docker.compose.project=ci-hub --filter status=exited
  docker ps -aq --filter label=com.docker.compose.project=ci-hub --filter status=created
} | sort -u)

# One line per candidate: <0 for ci-hub, 1 otherwise>|<name>|<missing source>. Sorted, so the
# Hub starts first and brings back what its own boot handles (Traefik).
candidates=""
for id in $ids; do
  info=$(docker inspect --format '{{.Name}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.Error}}' "$id" 2>/dev/null) || continue
  name=${info%%|*}; name=${name#/}
  rest=${info#*|}
  policy=${rest%%|*}
  error=${rest#*|}
  case "$policy" in unless-stopped|always) ;; *) continue ;; esac
  case "$error" in *"error mounting"*) ;; *) continue ;; esac
  src=$(printf '%s\n' "$error" | sed -n 's/.*mount src=\([^,]*\),.*/\1/p')
  [ -n "$src" ] || continue
  if [ "$name" = "ci-hub" ]; then rank=0; else rank=1; fi
  candidates="$candidates$rank|$name|$src
"
done

if [ -z "$candidates" ]; then
  exit 0
fi

printf '%s' "$candidates" | sort | while IFS='|' read -r rank name src; do
  [ -n "$name" ] || continue
  j=0
  while [ ! -e "$src" ] && [ "$j" -lt 30 ]; do
    j=$((j + 1))
    sleep 2
  done
  if [ ! -e "$src" ]; then
    log "left $name stopped: $src is still missing"
    continue
  fi
  if docker start "$name" >/dev/null 2>&1; then
    log "started $name, which could not mount $src at boot"
  else
    log "could not start $name"
  fi
done
exit 0
