#!/usr/bin/env bash
# Copy the files this repo publishes into a clone of a package-manager repo (homebrew-tap, scoop-bucket).
# Usage: sync-published-files.sh <source_dir> <dest_dir>
#
# Additive on purpose: the tap and the bucket are shared with other apps, so this writes the files under
# <source_dir> and never deletes or touches anything else. README.md is only written when the destination has
# none, and a file this repo stops publishing is deleted in the destination by hand.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <source_dir> <dest_dir>" >&2
  exit 2
fi

SRC="${1%/}"
DEST="${2%/}"

[[ -d "$SRC" ]] || { echo "Source directory not found: $SRC" >&2; exit 1; }
[[ -d "$DEST" ]] || { echo "Destination directory not found: $DEST" >&2; exit 1; }

wrote=0
while IFS= read -r -d '' rel; do
  rel="${rel#./}"
  if [[ "$rel" == "README.md" && -e "$DEST/$rel" ]]; then
    echo "  kept    $rel (the destination already has one)"
    continue
  fi
  if [[ -f "$DEST/$rel" ]] && cmp -s "$SRC/$rel" "$DEST/$rel"; then
    continue
  fi
  mkdir -p "$(dirname "$DEST/$rel")"
  cp -p "$SRC/$rel" "$DEST/$rel"
  echo "  wrote   $rel"
  wrote=$((wrote + 1))
done < <(cd "$SRC" && find . -type f -not -path './.git/*' -print0 | sort -z)

echo "Synced ${wrote} file(s) from ${SRC##*/}; nothing else in the destination was touched."
