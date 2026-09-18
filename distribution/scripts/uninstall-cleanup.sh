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

# BEGIN hub tunnel folder cleanup (identical in every Linux uninstall script)
# The desktop keeps its Cloudflare tunnel token in a folder named `tunnel` beside its
# data folder (compose mounts ${ROOT_FOLDER_HOST}/../tunnel), not inside it, so removing
# the data folder leaves the token behind and a reinstall reconnects the old tunnel
# before it is paired. `tunnel` is a generic name another program could also use, so
# only what the Hub writes there is removed, and the folder only once it is empty.

# True when the file decodes as a cloudflared tunnel token: base64 of a JSON object
# holding the account tag (a), tunnel id (t) and tunnel secret (s).
is_cloudflared_tunnel_token() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  tunnel_size="$(wc -c <"$1" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$tunnel_size" ] && [ "$tunnel_size" -gt 0 ] && [ "$tunnel_size" -le 4096 ] || return 1
  tunnel_encoded="$(tr -d '[:space:]' <"$1")"
  case $((${#tunnel_encoded} % 4)) in
    2) tunnel_encoded="$tunnel_encoded==" ;;
    3) tunnel_encoded="$tunnel_encoded=" ;;
  esac
  tunnel_decoded="$(printf '%s' "$tunnel_encoded" | base64 -d 2>/dev/null | tr -d '[:space:][:cntrl:]')"
  case "$tunnel_decoded" in '{'*'}') ;; *) return 1 ;; esac
  for tunnel_key in a t s; do
    case "$tunnel_decoded" in *"\"$tunnel_key\":"*) ;; *) return 1 ;; esac
  done
  return 0
}

cleanup_hub_tunnel_dir() {
  tunnel_dir="$1"
  # Runs as root over every home: never follow a symlinked folder.
  [ -d "$tunnel_dir" ] && [ ! -L "$tunnel_dir" ] || return 0

  if is_cloudflared_tunnel_token "$tunnel_dir/token"; then
    rm -f "$tunnel_dir/token" >/dev/null 2>&1 || true
  fi
  # Marker files the backend writes beside the token: {"tunnelId": ..., "writtenAt"|"foundAt": ...}.
  for tunnel_marker in registration.json leftover.json; do
    if [ -f "$tunnel_dir/$tunnel_marker" ] && [ ! -L "$tunnel_dir/$tunnel_marker" ] &&
      grep -q '"tunnelId"' "$tunnel_dir/$tunnel_marker" 2>/dev/null; then
      rm -f "$tunnel_dir/$tunnel_marker" >/dev/null 2>&1 || true
    fi
  done
  # Written by the desktop when the user clears the token from the tray.
  [ -d "$tunnel_dir/.user-cleared-token" ] || rm -f "$tunnel_dir/.user-cleared-token" >/dev/null 2>&1 || true
  # The backend creates certs/ empty; anything inside it belongs to something else.
  rmdir "$tunnel_dir/certs" >/dev/null 2>&1 || true
  rmdir "$tunnel_dir" >/dev/null 2>&1 || true
}
# END hub tunnel folder cleanup

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

  cleanup_hub_tunnel_dir "$xdg_data_home/tunnel"
}

if command -v docker >/dev/null 2>&1; then
  collect_names() {
    docker ps -a "$@" --format '{{.Names}}' 2>/dev/null || true
  }

  # Echo unique image IDs used by a compose project (pulled or built); call before
  # removing the project's containers so disk can be reclaimed afterwards.
  snapshot_project_images() {
    project="$1"
    {
      docker ps -a --filter "label=com.docker.compose.project=$project" -q 2>/dev/null |
        while IFS= read -r cid; do [ -n "$cid" ] && docker inspect --format '{{.Image}}' "$cid" 2>/dev/null; done
      docker images --filter "label=com.docker.compose.project=$project" -q 2>/dev/null
    } | awk 'NF && !seen[$0]++'
  }

  remove_images() {
    while IFS= read -r img; do
      [ -n "$img" ] && run_cmd "docker image rm -f $img" || true
    done
  }

  # Marketplace apps run as their own compose projects (<app>_<store>), separate
  # from the Hub stack. Hub stamps every managed app container with
  # `ci-hub.managed=true`; pre-rename apps carry `ci-os-hub.managed=true`.
  # Discover the union, then remove each project's containers, networks (except
  # the shared Hub networks), volumes, and images.
  {
    docker ps -a --filter "label=ci-hub.managed=true" \
      --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null || true
    docker ps -a --filter "label=ci-os-hub.managed=true" \
      --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null || true
  } | awk 'NF && !seen[$0]++' |
    while IFS= read -r project; do
      [ -n "$project" ] || continue
      case "$project" in *[!A-Za-z0-9_.-]*) continue ;; esac
      # Hub's own services also carry managed=true; the dedicated Hub-stack
      # cleanup below is the single source of truth, so skip it here.
      case "$project" in ci-os-hub|ci-hub) continue ;; esac
      project_images="$(snapshot_project_images "$project")"
      docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' 2>/dev/null |
        while IFS= read -r cid; do [ -n "$cid" ] && run_cmd "docker rm -f $cid" || true; done
      docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' 2>/dev/null |
        while IFS= read -r net; do
          case "$net" in
            ''|bridge|host|none|ci_hub_network|ci-hub_network|ci_os_hub_network|ci-os-hub_network) ;;
            *) run_cmd "docker network rm $net" || true ;;
          esac
        done
      docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' 2>/dev/null |
        while IFS= read -r vol; do [ -n "$vol" ] && run_cmd "docker volume rm $vol" || true; done
      printf '%s\n' "$project_images" | remove_images
    done

  hub_images="$({ snapshot_project_images "ci-os-hub"; snapshot_project_images "ci-hub"; } | awk 'NF && !seen[$0]++')"

  all_containers="$(
    {
      collect_names --filter "label=com.docker.compose.project=ci-os-hub"
      collect_names --filter "label=com.docker.compose.project=ci-hub"
      collect_names --filter "network=ci_hub_network"
      collect_names --filter "network=ci-hub_network"
      collect_names --filter "network=ci_os_hub_network"
      collect_names --filter "network=ci-os-hub_network"
    } | awk 'NF && !seen[$0]++'
  )"

  if [ -n "$all_containers" ]; then
    echo "$all_containers" | while IFS= read -r name; do
      run_cmd "docker rm -f $name" || true
    done
  fi

  for network in ci_hub_network ci-hub_network ci_os_hub_network ci-os-hub_network; do
    run_cmd "docker network rm $network" || true
  done

  docker volume ls --format '{{.Name}}' 2>/dev/null | while IFS= read -r volume; do
    case "$volume" in
      *ci_os_hub*|*ci-os-hub*|*ci_hub_pgdata*|*ci_hub_app_data*|*hub_tailscale_state*)
        run_cmd "docker volume rm $volume" || true
        ;;
    esac
  done

  printf '%s\n' "$hub_images" | remove_images
fi

list_home_dirs | while IFS= read -r home_dir; do
  cleanup_user_home "$home_dir"
done

log INFO "uninstall cleanup finished"
