#!/usr/bin/env bash
# Push Homebrew tap + Scoop bucket to companionintelligence/* repos.
# Requires GH_TOKEN with repo scope on the org.
# Usage: ./distribution/scripts/publish-package-managers.sh [commit message suffix]
set -euo pipefail

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN is required (set CI_PACKAGE_MANAGERS_TOKEN in CI-Hub Actions secrets)" >&2
  exit 1
fi

export GIT_TERMINAL_PROMPT=0
# Actions always injects GITHUB_TOKEN; gh/git may prefer it over our PAT unless we
# authenticate explicitly. Unset it so every gh/git call uses CI_PACKAGE_MANAGERS_TOKEN.
unset GITHUB_TOKEN
printf '%s\n' "$GH_TOKEN" | gh auth login --with-token
gh auth setup-git

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/distribution/publish"
MSG="${1:-Update Companion Hub package manifests}"

assert_repo_push_access() {
  local repo_name="$1"
  local login can_push
  login="$(gh api user --jq .login)"
  can_push="$(gh api "repos/companionintelligence/${repo_name}" --jq '.permissions.push // false')"
  if [[ "$can_push" != "true" ]]; then
    echo "CI_PACKAGE_MANAGERS_TOKEN (authenticated as ${login}) cannot push to companionintelligence/${repo_name}." >&2
    echo "Use a PAT with Contents: Read and write on homebrew-tap and scoop-bucket." >&2
    exit 1
  fi
}

publish_repo() {
  local repo_name="$1"
  local source_dir="$2"
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN

  assert_repo_push_access "$repo_name"

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
    # Force the PAT embedded in the remote URL; ignore credential helpers.
    git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/companionintelligence/${repo_name}.git"
    git -c credential.helper= push origin HEAD
  )
  echo "Published ${repo_name}"
}

publish_repo "homebrew-tap" "$DIST/homebrew-tap"
publish_repo "scoop-bucket" "$DIST/scoop-bucket"

echo "Done. Install with:"
echo "  brew tap companionintelligence/homebrew-tap && brew install --cask companion-hub"
echo "  scoop bucket add companionintelligence https://github.com/companionintelligence/scoop-bucket && scoop install companion-hub"
