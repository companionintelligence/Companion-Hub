#!/usr/bin/env bash
# Fail when a Rust source file grows past the module size budget.
#
# hub_manager.rs reached 11,338 lines before anyone noticed. This is the ratchet
# that stops it happening again: every file over the budget must be listed in
# ALLOW below, and entries come off that list as the split progresses. Nothing
# may be added to it without a very good reason.
set -euo pipefail

BUDGET="${MODULE_LINE_BUDGET:-900}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Known-oversized files, with their size when the ratchet was introduced.
# Remove an entry once its file is under BUDGET — never raise a number.
ALLOW="
src/hub_manager.rs
src/updater.rs
src/inference_runners.rs
src/main.rs
src/docker_engine.rs
src/error_reporting.rs
"

status=0
while IFS= read -r file; do
  rel="${file#"$ROOT"/}"
  lines=$(wc -l < "$file")

  if grep -qxF "$rel" <<<"$ALLOW"; then
    # Allowlisted: report progress, but never fail.
    if [ "$lines" -le "$BUDGET" ]; then
      echo "OK   $rel ($lines) — now under budget, drop it from ALLOW"
    else
      echo "ALLOW $rel ($lines)"
    fi
    continue
  fi

  if [ "$lines" -gt "$BUDGET" ]; then
    echo "::error file=packages/desktop/src-tauri/$rel::$rel is $lines lines (budget $BUDGET)"
    status=1
  fi
done < <(find "$ROOT/src" -name '*.rs' -type f | sort)

exit "$status"
