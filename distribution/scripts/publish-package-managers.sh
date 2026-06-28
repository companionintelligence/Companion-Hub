#!/usr/bin/env bash
# Push Homebrew tap + Scoop bucket to companionintelligence/* repos.
# Requires GH_TOKEN with Contents: Write on homebrew-tap and scoop-bucket.
# Usage: ./distribution/scripts/publish-package-managers.sh [commit message suffix]
set -euo pipefail

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN is required (set CI_PACKAGE_MANAGERS_TOKEN in CI-Hub Actions secrets)" >&2
  exit 1
fi

export GIT_TERMINAL_PROMPT=0
# Actions injects GITHUB_TOKEN for the CI-Hub repo; it cannot push to other repos.
# Never run gh auth setup-git here — it can make plain git prefer the wrong credentials.
unset GITHUB_TOKEN

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/distribution/publish"
MSG="${1:-Update Companion Hub package manifests}"

repo_origin() {
  printf 'https://x-access-token:%s@github.com/companionintelligence/%s.git' "$GH_TOKEN" "$1"
}

verify_publish_token() {
  local login repo can_push
  login="$(gh api user --jq .login)"
  echo "CI_PACKAGE_MANAGERS_TOKEN authenticated as: ${login}"

  for repo in homebrew-tap scoop-bucket; do
    if ! gh api "repos/companionintelligence/${repo}" &>/dev/null; then
      echo "Cannot read companionintelligence/${repo} with CI_PACKAGE_MANAGERS_TOKEN." >&2
      echo "Grant Contents: Read and write on both distribution repos (fine-grained PAT) or use a classic PAT with repo scope." >&2
      exit 1
    fi
    can_push="$(gh api "repos/companionintelligence/${repo}" --jq '.permissions.push // false')"
    if [[ "$can_push" != "true" ]]; then
      echo "CI_PACKAGE_MANAGERS_TOKEN (authenticated as ${login}) cannot push to companionintelligence/${repo}." >&2
      echo "Use a PAT from an account with write access to homebrew-tap and scoop-bucket." >&2
      echo "If the org uses SAML SSO, authorize the PAT for the companionintelligence org." >&2
      exit 1
    fi
    echo "Push access OK: companionintelligence/${repo}"
  done
}

publish_repo() {
  local repo_name="$1"
  local source_dir="$2"
  local work origin
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  origin="$(repo_origin "$repo_name")"

  if git ls-remote "$origin" HEAD &>/dev/null; then
    git -c credential.helper= clone --depth=1 "$origin" "$work"
  else
    echo "Creating companionintelligence/${repo_name} ..."
    gh repo create "companionintelligence/${repo_name}" \
      --public \
      --description "Companion Intelligence ${repo_name} for desktop app distribution"
    git -c credential.helper= clone --depth=1 "$origin" "$work"
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
    git remote set-url origin "$origin"
    git -c credential.helper= push origin HEAD
  )
  echo "Published ${repo_name}"
}

verify_publish_token
publish_repo "homebrew-tap" "$DIST/homebrew-tap"
publish_repo "scoop-bucket" "$DIST/scoop-bucket"

echo "Done. Install with:"
echo "  brew tap companionintelligence/homebrew-tap && brew install --cask companion-hub"
echo "  scoop bucket add companionintelligence https://github.com/companionintelligence/scoop-bucket && scoop install companion-hub"
