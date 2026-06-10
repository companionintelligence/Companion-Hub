#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DESKTOP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
POSTRM_SOURCE="$DESKTOP_DIR/src-tauri/linux/deb/postrm"

if [ "$(uname -s)" != "Linux" ]; then
  echo '[deb-patch][INFO] Non-Linux host detected; skipping Debian maintainer patch step.'
  exit 0
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo '[deb-patch][WARN] dpkg-deb not available; skipping Debian maintainer patch step.'
  exit 0
fi

if [ ! -f "$POSTRM_SOURCE" ]; then
  echo "[deb-patch][ERROR] Missing postrm source: $POSTRM_SOURCE" >&2
  exit 1
fi

find "$DESKTOP_DIR/src-tauri/target" -path '*/bundle/deb/*.deb' -type f 2>/dev/null | sort | while IFS= read -r deb_path; do
  [ -n "$deb_path" ] || continue
  temp_dir=$(mktemp -d)
  rebuilt_path="$deb_path.rebuilt"

  echo "[deb-patch][INFO] Patching maintainer scripts into $deb_path"
  dpkg-deb -R "$deb_path" "$temp_dir"
  install -Dm755 "$POSTRM_SOURCE" "$temp_dir/DEBIAN/postrm"
  dpkg-deb --build "$temp_dir" "$rebuilt_path" >/dev/null
  mv "$rebuilt_path" "$deb_path"
  rm -rf "$temp_dir"
done

if ! find "$DESKTOP_DIR/src-tauri/target" -path '*/bundle/deb/*.deb' -type f 2>/dev/null | grep -q .; then
  echo '[deb-patch][INFO] No .deb bundles found; nothing to patch.'
fi
