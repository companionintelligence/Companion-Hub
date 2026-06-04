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

TAG_REF="refs/tags/${TAG}"

# The release job creates the tag via softprops/action-gh-release; resolve the commit
# from GitHub first so we do not depend on checkout ref or ambiguous short tag names.
TARGET_COMMIT="$(gh release view "$TAG" -R "$REPO" --json targetCommitish --jq '.targetCommitish')"
if [[ -z "$TARGET_COMMIT" || "$TARGET_COMMIT" == "null" ]]; then
  echo "Could not read targetCommitish for release $TAG from $REPO" >&2
  exit 1
fi

git fetch --force origin "${TARGET_COMMIT}"
git fetch --force origin "${TAG_REF}:${TAG_REF}"

if ! git rev-parse --verify "${TAG_REF}^{commit}" >/dev/null 2>&1; then
  echo "Tag $TAG is missing locally after fetch (expected commit $TARGET_COMMIT)" >&2
  exit 1
fi

TAG_COMMIT="$(git rev-parse --verify "${TAG_REF}^{commit}")"
if [[ "$TAG_COMMIT" != "$TARGET_COMMIT" ]]; then
  echo "Tag $TAG points to $TAG_COMMIT but release targetCommitish is $TARGET_COMMIT" >&2
  echo "Continuing with release targetCommitish." >&2
fi

RELEASE_NAME="$(gh release view "$TAG" -R "$REPO" --json name --jq '.name')"
gh release view "$TAG" -R "$REPO" --json body --jq '.body' > "$BODY_FILE"

git config user.name "$BOT_NAME"
git config user.email "$BOT_EMAIL"

git tag -fa "$TAG" "$TARGET_COMMIT" -m "Release $TAG" -m "Refreshed by desktop release finalization to keep GitHub release ordering current." >/dev/null

LOCAL_TAG_SHA="$(git rev-parse --verify "${TAG_REF}")"
git push --force origin "${TAG_REF}"

REMOTE_TAG_SHA="$(git ls-remote origin "${TAG_REF}" | awk 'NR==1 { print $1 }')"
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
