#!/usr/bin/env bash
# Run the desktop crate's Tauri-free unit tests without the GTK/WebKit stack.
#
# `cargo test` on this crate needs libwebkit2gtk, libgtk-3, libdbus-1 and friends, because the crate
# depends on `tauri`. On a machine without them the build dies in `libdbus-sys` and none of the
# ~155 tests run — including the ones for modules that never touch Tauri at all.
#
# Those modules are the bulk of the crate: hub_manager (the Docker/host engine), docker_engine,
# port_manager, hub_env, hub_names, error_reporting and sentry_scrubber contain no `tauri::`
# reference. This script copies them into a scratch crate with only their real dependencies and
# runs their tests there, so a contributor without the GUI headers can still verify a change.
#
# What this does NOT cover: main.rs, tray.rs and commands/ — those are genuinely Tauri-coupled and
# need the full toolchain. Use it as a fast local gate, not as a replacement for desktop-tests.yml.
#
# Usage:
#   packages/desktop/src-tauri/scripts/test-without-gui.sh            # test the working tree
#   packages/desktop/src-tauri/scripts/test-without-gui.sh origin/dev # test a git ref
set -euo pipefail

REF="${1:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
WORK="${TMPDIR:-/tmp}/ci-hub-rust-nogui"
CRATE="$WORK/packages/desktop/src-tauri"
SRC="$CRATE/src"

# Modules with no `tauri::` reference. Keep in step with the crate: if one of these grows a Tauri
# dependency it belongs in the excluded set instead, and this script should stop copying it.
TAURI_FREE=(docker_engine port_manager hub_names hub_env error_reporting sentry_scrubber)

rm -rf "$SRC"
mkdir -p "$SRC" "$CRATE/resources" "$WORK/packages/backend/assets/traefik/dynamic"

# include_str! targets, at the depth the real tree puts them.
cp "$REPO_ROOT/packages/backend/assets/traefik/traefik.yml" "$WORK/packages/backend/assets/traefik/"
cp "$REPO_ROOT/packages/backend/assets/traefik/dynamic/dynamic.yml" "$WORK/packages/backend/assets/traefik/dynamic/"
cp "$REPO_ROOT/packages/desktop/src-tauri/resources/docker-compose.prod.yml" "$CRATE/resources/"

copy_module() {
  local rel="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -n "$REF" ]; then
    git -C "$REPO_ROOT" show "$REF:$rel" > "$dest"
  else
    cp "$REPO_ROOT/$rel" "$dest"
  fi
}

# hub_manager is a directory now and was a single file before the split, so handle both — that is
# what lets this script diff a refactor against the ref it came from.
HM_DIR=packages/desktop/src-tauri/src/hub_manager
HM_FILE=packages/desktop/src-tauri/src/hub_manager.rs
HM_FILES=()
if [ -n "$REF" ]; then
  if git -C "$REPO_ROOT" cat-file -e "$REF:$HM_FILE" 2>/dev/null; then
    HM_FILES=("$HM_FILE")
  else
    mapfile -t HM_FILES < <(git -C "$REPO_ROOT" ls-tree -r --name-only "$REF" -- "$HM_DIR/")
  fi
elif [ -f "$REPO_ROOT/$HM_FILE" ]; then
  HM_FILES=("$HM_FILE")
else
  mapfile -t HM_FILES < <(cd "$REPO_ROOT" && find "$HM_DIR" -name '*.rs')
fi
if [ ${#HM_FILES[@]} -eq 0 ]; then
  echo "No hub_manager sources found${REF:+ at $REF}" >&2
  exit 1
fi
for f in "${HM_FILES[@]}"; do
  copy_module "$f" "$SRC/${f#packages/desktop/src-tauri/src/}"
done
for m in "${TAURI_FREE[@]}"; do
  copy_module "packages/desktop/src-tauri/src/$m.rs" "$SRC/$m.rs"
done

{
  echo "pub mod hub_manager;"
  for m in "${TAURI_FREE[@]}"; do echo "pub mod $m;"; done
} | sort > "$SRC/lib.rs"

# Mirrors the real Cargo.toml minus tauri and its plugins. rustls rather than the default
# native-tls, so no system OpenSSL is needed either.
cat > "$CRATE/Cargo.toml" <<'TOML'
[package]
name = "hub-manager-nogui"
version = "0.0.0"
edition = "2021"

[lib]
name = "hub_manager_nogui"
path = "src/lib.rs"

[dependencies]
chrono = "0.4"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", default-features = false, features = ["json", "blocking", "rustls-tls"] }
sha2 = "0.10"
log = "0.4"
dirs = "5"
rand = "0.8"
regex = "1"
tempfile = "3"
sentry = { version = "0.36", default-features = false, features = ["backtrace", "contexts", "panic", "reqwest", "rustls"] }

[target.'cfg(unix)'.dependencies]
libc = "0.2"
TOML

cd "$CRATE"
echo "Running Tauri-free desktop tests${REF:+ for $REF} in $CRATE"
# hub_watchdog_decision shells out to `docker` and fails wherever the daemon is absent; it fails
# identically before and after any refactor, so it is excluded rather than allowed to mask a real
# regression. Run without --skip to see it.
cargo test --lib -- --skip hub_watchdog_decision
