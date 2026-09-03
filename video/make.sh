#!/usr/bin/env bash
#
# Build the product video ON THIS MACHINE. No GitHub Actions, nothing uploaded.
#
#   ./video/make.sh                 stage the app, capture, check, render
#   ./video/make.sh --no-render     capture and check only (much faster)
#   ./video/make.sh --only <id>     re-shoot a single shot by id
#   ./video/make.sh --keep-up       leave the stage running when it finishes
#
# THIS FILE IS A SHIM. It finds the kit and hands over; the runner itself is
# @companionintelligence/video-kit's bin/make.sh, and every flag above is
# parsed there. Everything repo-specific lives in video/stage.sh, which defines
# stage_up and stage_down.
#
# It is deliberately this short. The kit used to distribute the whole 370-line
# runner as a thing to COPY, and eight repos carried a copy carrying no
# per-repo configuration at all — so a fix to the runner was a fleet-wide
# rewrite, and twice it was a fleet-wide rewrite that only landed in some of
# them. `ci-video doctor` still compares this file against the kit's
# template/make.sh, but there is far less here to drift.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$PWD"

# Walk UP looking for the workspace, rather than assuming it is the parent
# directory. This checkout may be a git worktree (../ is .worktrees/) or a
# nested clone, and in both cases the sibling-directory guess is wrong.
#
# The walk looks for the kit DIRECTORY, not for bin/make.sh inside it, so that
# finding an old kit is distinguishable from finding no kit — see below.
KIT_REL="CI-Common/packages/video-kit"
KIT_DIR=""
if [ -n "${CI_WORKSPACE:-}" ]; then
  KIT_DIR="$CI_WORKSPACE/$KIT_REL"
else
  d="$REPO_ROOT"
  while [ "$d" != "/" ]; do
    if [ -d "$d/$KIT_REL" ]; then KIT_DIR="$d/$KIT_REL"; break; fi
    d="$(dirname "$d")"
  done
fi

# Three outcomes, and the middle one is why this is not a one-liner: a kit older
# than 0.17.0 ships the runner at template/make.sh and has no bin/make.sh, so
# "not found" would send a reader looking for a clone they already have.
if [ -n "$KIT_DIR" ] && [ -f "$KIT_DIR/bin/make.sh" ]; then
  # The runner lives in the kit and is shared by every product, so it cannot
  # work out which repo it is filming. Tell it.
  export CI_VIDEO_REPO_ROOT="$REPO_ROOT"
  exec bash "$KIT_DIR/bin/make.sh" "$@"
elif [ -n "$KIT_DIR" ] && [ -f "$KIT_DIR/template/make.sh" ]; then
  echo "x video-kit at $KIT_DIR is older than 0.17.0 — it has no bin/make.sh." >&2
  echo "  Update CI-Common, or run that kit's template/make.sh copy directly." >&2
  exit 1
else
  echo "x video-kit not found (looked for */$KIT_REL above $REPO_ROOT)" >&2
  echo "  Clone CI-Common into the workspace, or set CI_WORKSPACE to the directory holding it." >&2
  exit 1
fi
