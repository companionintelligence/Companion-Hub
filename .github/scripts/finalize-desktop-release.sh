#!/usr/bin/env bash

set -euo pipefail

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
TAG="${RELEASE_TAG:?RELEASE_TAG is required}"
RELEASE_FILES_DIR="${RELEASE_FILES_DIR:?RELEASE_FILES_DIR is required}"
BOT_NAME="github-actions[bot]"
BOT_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$'

if [[ ! "$TAG" =~ $TAG_PATTERN ]]; then
  echo "Invalid release tag format: $TAG" >&2
  echo "Expected tags like v0.2.2 or v0.2.2-beta.1" >&2
  exit 1
fi

if [[ ! -d "$RELEASE_FILES_DIR" ]]; then
  echo "Release files directory does not exist: $RELEASE_FILES_DIR" >&2
  exit 1
fi

mapfile -d '' RELEASE_ASSETS < <(find "$RELEASE_FILES_DIR" -maxdepth 1 -type f -print0 | sort -z)

if [[ ${#RELEASE_ASSETS[@]} -eq 0 ]]; then
  echo "No release assets found in $RELEASE_FILES_DIR" >&2
  exit 1
fi

BODY_FILE="$(mktemp)"
cleanup() {
  rm -f "$BODY_FILE"
}
trap cleanup EXIT

resolve_target_commit_from_git() {
  local commit=""
  commit="$(git rev-parse --verify "${TAG}^{commit}" 2>/dev/null || true)"
  if [[ -n "$commit" ]]; then
    echo "$commit"
    return 0
  fi
  return 1
}

resolve_target_commit_from_release_api() {
  if ! gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
    return 1
  fi

  local target_commitish=""
  target_commitish="$(gh api "repos/${REPO}/releases/tags/${TAG}" --jq '.target_commitish' 2>/dev/null || true)"
  if [[ -z "$target_commitish" || "$target_commitish" == "null" ]]; then
    return 1
  fi

  local commit=""
  commit="$(git rev-parse --verify "${target_commitish}^{commit}" 2>/dev/null || true)"
  if [[ -n "$commit" ]]; then
    echo "$commit"
    return 0
  fi

  if [[ "$target_commitish" =~ ^[0-9a-f]{40}$ ]]; then
    echo "$target_commitish"
    return 0
  fi

  return 1
}

TARGET_COMMIT=""
for i in 1 2 3 4 5; do
  git fetch --force origin "refs/tags/${TAG}:refs/tags/${TAG}" >/dev/null 2>&1 || true
  if TARGET_COMMIT="$(resolve_target_commit_from_git)"; then
    break
  fi
  if [[ $i -eq 5 ]]; then
    TARGET_COMMIT="$(resolve_target_commit_from_release_api || true)"
    if [[ -z "$TARGET_COMMIT" ]]; then
      echo "Could not resolve target commit for $TAG after 5 fetch attempts and release API fallback" >&2
      exit 1
    fi
    echo "Resolved $TAG via GitHub Releases API fallback: $TARGET_COMMIT" >&2
    break
  fi
  echo "Attempt $i/5: tag ${TAG} not yet resolvable via git, retrying in 15s..." >&2
  sleep 15
done

RELEASE_NAME="$(gh release view "$TAG" -R "$REPO" --json name --jq '.name')"
gh release view "$TAG" -R "$REPO" --json body --jq '.body' > "$BODY_FILE"

git config user.name "$BOT_NAME"
git config user.email "$BOT_EMAIL"

git tag -fa "$TAG" "$TARGET_COMMIT" -m "Release $TAG" -m "Refreshed by desktop release finalization to keep GitHub release ordering current." >/dev/null

LOCAL_TAG_SHA="$(git rev-parse --verify -- "$TAG")"
git push --force origin "refs/tags/${TAG}"

REMOTE_TAG_SHA="$(git ls-remote origin "refs/tags/${TAG}" | awk 'NR==1 { print $1 }')"
if [[ -z "$REMOTE_TAG_SHA" ]]; then
  echo "Could not verify $TAG on origin after push" >&2
  exit 1
fi

if [[ "$REMOTE_TAG_SHA" != "$LOCAL_TAG_SHA" ]]; then
  echo "Origin tag $TAG does not match local tag object after push" >&2
  echo "Local:  $LOCAL_TAG_SHA" >&2
  echo "Remote: $REMOTE_TAG_SHA" >&2
  exit 1
fi

gh release delete "$TAG" -R "$REPO" --yes

gh release create "$TAG" \
  "${RELEASE_ASSETS[@]}" \
  -R "$REPO" \
  --verify-tag \
  --title "$RELEASE_NAME" \
  --notes-file "$BODY_FILE" \
  --latest

LATEST_TAG="$(gh api "repos/${REPO}/releases/latest" --jq '.tag_name')"
if [[ "$LATEST_TAG" != "$TAG" ]]; then
  echo "Expected $TAG to be the latest release, got $LATEST_TAG" >&2
  exit 1
fi

RELEASE_URL="$(gh api "repos/${REPO}/releases/tags/${TAG}" --jq '.html_url')"
CREATED_AT="$(gh api "repos/${REPO}/releases/tags/${TAG}" --jq '.created_at')"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "## Desktop release finalized"
    echo "- Tag: \`$TAG\`"
    echo "- Commit: \`$TARGET_COMMIT\`"
    echo "- Release created at: \`$CREATED_AT\`"
    echo "- Release URL: $RELEASE_URL"
  } >> "$GITHUB_STEP_SUMMARY"
fi
