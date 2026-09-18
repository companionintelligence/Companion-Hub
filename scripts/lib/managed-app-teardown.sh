# shellcheck shell=bash
# Removes the marketplace apps a Hub installed, and the Hub stack containers, before a script
# deletes the Hub state they depend on. Sourced by scripts/nuke.sh and scripts/unsafe-cleanup.sh;
# `cihub reset` and `cihub uninstall` use the TypeScript equivalent in scripts/hub-cleanup-lib.ts.
#
# Why apps first: each app is its own compose project (`<app>_<store>`), outside the Hub stack,
# with bind mounts under the Hub data directory and Hub-issued credentials in its environment.
# On core-2 (2026-09-17) nuke.sh deleted .internal and the Hub containers only. ci-memory,
# OpenClaw, Hermes, and import-tools kept running against bind sources that no longer existed,
# and their Hub MCP calls to the fresh Hub returned 401.
#
# The managed labels carry no Hub identity, so this assumes one Hub per Docker daemon.

# The Hub's own compose projects. Their services carry the managed labels too, but are not apps.
MANAGED_APP_TEARDOWN_HUB_PROJECTS="ci-hub ci-os-hub runcihub"

# Prints the compose project of every Hub-managed app container, one per line, deduplicated.
# Returns 1 when Docker cannot list containers, which is not the same as "no apps".
managed_app_projects() {
  local label listed="" output
  for label in ci-hub.managed=true ci-os-hub.managed=true; do
    output=$(docker ps -a --filter "label=$label" --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null) || return 1
    listed+="$output"$'\n'
  done
  printf '%s' "$listed" | while IFS= read -r project; do
    [ -n "$project" ] || continue
    case " $MANAGED_APP_TEARDOWN_HUB_PROJECTS " in
      *" $project "*) continue ;;
    esac
    # Docker's compose-project charset. Anything else is not passed on to a docker command.
    if printf '%s\n' "$project" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*$'; then
      printf '%s\n' "$project"
    fi
  done | sort -u
}

# Removes one compose project's containers, networks, and named volumes.
remove_compose_project() {
  local project="$1" ids network volume
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$project")
  if [ -n "$ids" ]; then
    # Word splitting is intended: one container ID per argument.
    # shellcheck disable=SC2086
    docker rm -f $ids >/dev/null || true
  fi
  for network in $(docker network ls -q --filter "label=com.docker.compose.project=$project"); do
    docker network rm "$network" >/dev/null || true
  done
  for volume in $(docker volume ls -q --filter "label=com.docker.compose.project=$project"); do
    docker volume rm "$volume" >/dev/null || true
  done
}

# Usage: teardown_managed_apps remove|keep
#   remove  deletes every Hub-managed app (containers, networks, named volumes)
#   keep    leaves them running and prints what they still depend on
# In remove mode it returns 1 when Docker cannot list containers. Callers must stop then: app
# containers with a restart policy come back with the daemon, against the state deleted meanwhile.
teardown_managed_apps() {
  local mode="$1" projects project
  if ! projects=$(managed_app_projects); then
    if [ "$mode" = "keep" ]; then
      echo "WARNING: could not list Hub-managed apps (is Docker running?); keeping whatever exists." >&2
      return 0
    fi
    echo "Cannot list Hub-managed apps (is Docker running?), so they cannot be removed first." >&2
    echo "Nothing was deleted. Start Docker and run this again, or pass --keep-apps where supported." >&2
    return 1
  fi
  if [ -z "$projects" ]; then
    echo "No Hub-managed apps found."
    return 0
  fi

  if [ "$mode" = "keep" ]; then
    {
      echo "WARNING: keeping these Hub-managed apps:"
      for project in $projects; do echo "  $project"; done
      echo "They keep bind mounts into the Hub data directory this script deletes, and Hub"
      echo "credentials the next Hub will not honour, so their Hub MCP calls will return 401."
      echo "Remove one later with: docker compose -p <project> down -v"
    } >&2
    return 0
  fi

  echo "Removing Hub-managed apps (containers, networks, volumes):"
  for project in $projects; do
    echo "  $project"
    remove_compose_project "$project"
  done
}

# Removes the Hub stack's containers by compose project, which also catches the sidecars
# (traefik, cloudflared) that a fixed list of container names misses.
remove_hub_stack_containers() {
  local project ids
  for project in $MANAGED_APP_TEARDOWN_HUB_PROJECTS; do
    ids=$(docker ps -aq --filter "label=com.docker.compose.project=$project")
    if [ -n "$ids" ]; then
      # shellcheck disable=SC2086
      docker rm -f $ids >/dev/null || true
    fi
  done
}
