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

list_home_dirs() {
  getent passwd | awk -F: '($3 == 0 || $3 >= 1000) && $6 ~ /^\// { print $6 }' | awk '!seen[$0]++'
}

cleanup_user_home() {
  home_dir="$1"
  [ -d "$home_dir" ] || return 0

  xdg_data_home="${XDG_DATA_HOME:-$home_dir/.local/share}"
  xdg_config_home="${XDG_CONFIG_HOME:-$home_dir/.config}"
  xdg_cache_home="${XDG_CACHE_HOME:-$home_dir/.cache}"

  case "$xdg_data_home" in "$home_dir"/*) ;; *) xdg_data_home="$home_dir/.local/share" ;; esac
  case "$xdg_config_home" in "$home_dir"/*) ;; *) xdg_config_home="$home_dir/.config" ;; esac
  case "$xdg_cache_home" in "$home_dir"/*) ;; *) xdg_cache_home="$home_dir/.cache" ;; esac

  for name in "Companion Hub" "companion-hub" "ci-hub" "CI-Hub" "computer.ci.app.hub"; do
    remove_dir_if_exists "$xdg_data_home/$name"
    remove_dir_if_exists "$xdg_config_home/$name"
    remove_dir_if_exists "$xdg_cache_home/$name"
  done

  remove_dir_if_exists "$home_dir/.local/share/applications/companion-hub.desktop"
  remove_dir_if_exists "$home_dir/.cache/companion-hub"
}

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

  for network in ci_os_hub_network ci-os-hub_network; do
    run_cmd "docker network rm $network" || true
  done

  docker volume ls --format '{{.Name}}' 2>/dev/null | while IFS= read -r volume; do
    case "$volume" in
      *ci_os_hub*|*ci-os-hub*|runtipi_*|*ci_hub_pgdata*|*ci_hub_app_data*|*hub_tailscale_state*|e2e-*|test-e2e-*)
        run_cmd "docker volume rm $volume" || true
        ;;
    esac
  done
fi

list_home_dirs | while IFS= read -r home_dir; do
  cleanup_user_home "$home_dir"
done

log INFO "uninstall cleanup finished"
