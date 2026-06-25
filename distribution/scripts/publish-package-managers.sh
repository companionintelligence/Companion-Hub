#!/usr/bin/env bash
# Push Homebrew tap + Scoop bucket to companionintelligence/* repos.
# Requires GH_TOKEN with repo scope on the org.
# Usage: ./distribution/scripts/publish-package-managers.sh [commit message suffix]
set -euo pipefail

if [[ -z "${GH_TOKEN:-}" ]] && ! gh auth status &>/dev/null; then
  echo "GH_TOKEN or gh auth required" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/distribution/publish"
MSG="${1:-Update Companion Hub package manifests}"

publish_repo() {
  local repo_name="$1"
  local source_dir="$2"
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN

  if gh repo view "companionintelligence/${repo_name}" &>/dev/null; then
    gh repo clone "companionintelligence/${repo_name}" "$work" -- --depth=1
  else
    echo "Creating companionintelligence/${repo_name} ..."
    gh repo create "companionintelligence/${repo_name}" \
      --public \
      --description "Companion Intelligence ${repo_name} for desktop app distribution"
    gh repo clone "companionintelligence/${repo_name}" "$work" -- --depth=1
  fi

  rsync -a --delete --exclude '.git' "${source_dir}/" "${work}/"
  (
    cd "$work"
    git add -A
    if git diff --staged --quiet; then
      echo "No changes for ${repo_name}"
      return 0
    fi
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git commit -m "chore: ${MSG}"
    git push origin HEAD
  )
  echo "Published ${repo_name}"
}

publish_repo "homebrew-tap" "$DIST/homebrew-tap"
publish_repo "scoop-bucket" "$DIST/scoop-bucket"

echo "Done. Install with:"
echo "  brew tap companionintelligence/homebrew-tap && brew install --cask companion-hub"
echo "  scoop bucket add companionintelligence https://github.com/companionintelligence/scoop-bucket && scoop install companion-hub"
