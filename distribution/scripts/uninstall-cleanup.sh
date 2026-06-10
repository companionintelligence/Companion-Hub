#!/usr/bin/env sh
# Companion Hub uninstall cleanup (best effort, idempotent)
set -eu

log() {
  level="$1"
  shift
  printf '[cleanup][%s] %s\n' "$level" "$*"
}

run_cmd() {
  cmd="$1"
  if sh -c "$cmd" >/dev/null 2>&1; then
    return 0
  fi
  log WARN "command failed: $cmd"
  return 1
}

remove_dir_if_exists() {
  target="$1"
  if [ -e "$target" ]; then
    rm -rf "$target" 2>/dev/null || log WARN "failed removing $target"
  fi
}

HOME_DIR="${HOME:-}"
if [ -z "$HOME_DIR" ]; then
  log WARN "HOME is not set; skipping user directory cleanup"
  exit 0
fi

XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME_DIR/.local/share}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME_DIR/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME_DIR/.cache}"

if command -v docker >/dev/null 2>&1; then
  collect_names() {
    docker ps -a "$@" --format '{{.Names}}' 2>/dev/null || true
  }

  all_containers="$(
    {
      collect_names --filter "label=com.docker.compose.project=ci-os-hub"
      collect_names --filter "label=com.docker.compose.project=ci-hub"
      collect_names --filter "label=com.docker.compose.project=runtipi"
      collect_names --filter "network=ci_os_hub_network"
      collect_names --filter "network=ci-os-hub_network"
    } | awk 'NF && !seen[$0]++'
  )"

  if [ -n "$all_containers" ]; then
    echo "$all_containers" | while IFS= read -r name; do
      run_cmd "docker rm -f $name" || true
    done
  fi
fi

for network in ci_os_hub_network ci-os-hub_network; do
  run_cmd "docker network rm $network" || true
done

if command -v docker >/dev/null 2>&1; then
  docker volume ls --format '{{.Name}}' 2>/dev/null | while IFS= read -r volume; do
    case "$volume" in
      *ci_os_hub*|*ci-os-hub*|*runtipi*|*ci_hub_pgdata*|e2e-*|test-e2e-*)
        run_cmd "docker volume rm $volume" || true
        ;;
    esac
  done
fi

for name in "Companion Hub" "companion-hub" "ci-hub" "CI-Hub" "computer.ci.app.hub"; do
  remove_dir_if_exists "$XDG_DATA_HOME/$name"
  remove_dir_if_exists "$XDG_CONFIG_HOME/$name"
  remove_dir_if_exists "$XDG_CACHE_HOME/$name"
done

remove_dir_if_exists "$HOME_DIR/.local/share/applications/companion-hub.desktop"
remove_dir_if_exists "$HOME_DIR/.cache/companion-hub"

log INFO "uninstall cleanup finished"
