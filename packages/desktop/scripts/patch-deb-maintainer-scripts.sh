#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DESKTOP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
POSTRM_SOURCE="$DESKTOP_DIR/src-tauri/linux/deb/postrm"
METAINFO_SOURCE="$DESKTOP_DIR/src-tauri/linux/companion-hub.metainfo.xml"
LONG_DESCRIPTION_SOURCE="$DESKTOP_DIR/src-tauri/linux/deb/description-long.txt"

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

if [ ! -f "$METAINFO_SOURCE" ]; then
  echo "[deb-patch][ERROR] Missing metainfo source: $METAINFO_SOURCE" >&2
  exit 1
fi

if [ ! -f "$LONG_DESCRIPTION_SOURCE" ]; then
  echo "[deb-patch][ERROR] Missing long description source: $LONG_DESCRIPTION_SOURCE" >&2
  exit 1
fi

find "$DESKTOP_DIR/src-tauri/target" -path '*/bundle/deb/*.deb' -type f 2>/dev/null | sort | while IFS= read -r deb_path; do
  [ -n "$deb_path" ] || continue
  (
    temp_dir=$(mktemp -d)
    trap 'rm -rf "$temp_dir"' EXIT
    rebuilt_path="$deb_path.rebuilt"

    echo "[deb-patch][INFO] Patching maintainer scripts into $deb_path"
    dpkg-deb -R "$deb_path" "$temp_dir"
    install -Dm755 "$POSTRM_SOURCE" "$temp_dir/DEBIAN/postrm"
    install -Dm644 "$METAINFO_SOURCE" "$temp_dir/usr/share/metainfo/computer.ci.app.hub.metainfo.xml"
    python3 - "$temp_dir/DEBIAN/control" "$LONG_DESCRIPTION_SOURCE" <<'PY'
from pathlib import Path
import sys

control_path = Path(sys.argv[1])
long_description_path = Path(sys.argv[2])

control_lines = control_path.read_text().splitlines()
long_description_lines = long_description_path.read_text().splitlines()
result = []
i = 0

while i < len(control_lines):
    line = control_lines[i]
    if line.startswith("Description:"):
        result.append(line)
        result.extend(long_description_lines)
        i += 1
        while i < len(control_lines) and control_lines[i].startswith(" "):
            i += 1
        continue
    result.append(line)
    i += 1

control_path.write_text("\n".join(result) + "\n")
PY
    dpkg-deb --build "$temp_dir" "$rebuilt_path" >/dev/null
    mv "$rebuilt_path" "$deb_path"
  )
done

if ! find "$DESKTOP_DIR/src-tauri/target" -path '*/bundle/deb/*.deb' -type f 2>/dev/null | grep -q .; then
  echo '[deb-patch][INFO] No .deb bundles found; nothing to patch.'
fi
