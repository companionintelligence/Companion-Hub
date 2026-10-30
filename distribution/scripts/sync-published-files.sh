#!/usr/bin/env bash
# Copy the files this repo publishes into a clone of a package-manager repo (homebrew-tap, scoop-bucket).
# Usage: sync-published-files.sh <source_dir> <dest_dir>
#
# Additive on purpose. The tap and the bucket are shared: they also hold the entries for other apps
# (Companion Capture, Companion Memory, Agent Sync) that are maintained outside this repo. This script
# writes the files that exist under <source_dir> and nothing else: it never deletes, and it never
# touches a file that is not in <source_dir>. Publishing used to be `rsync -a --delete`, which removed
# every one of those entries on the next Hub production release.
#
# README.md is the one file that describes the destination as a whole, not one app, so it is only
# written when the destination has none yet (a repo that was just created). A README that someone has
# since extended is left alone.
#
# To retire a file this repo used to publish, delete it in the destination repo by hand.
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
