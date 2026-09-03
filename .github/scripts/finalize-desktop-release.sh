#!/usr/bin/env bash

set -euo pipefail

# Finalize a desktop release by marking it as the "Latest" GitHub release.
#
# The `release` job already created the GitHub release with its tag, generated
# notes and every platform asset. This step runs only after the R2 upload and
# manifest jobs succeed (see `needs:` in desktop-release.yml), so its sole
# responsibility is to flip the freshly-published release to "Latest" once the
# download infrastructure is live. It performs no git tag surgery and never
# deletes/recreates the release, so it is idempotent and safe to re-run.

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
TAG="${RELEASE_TAG:?RELEASE_TAG is required}"
TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$'

if [[ ! "$TAG" =~ $TAG_PATTERN ]]; then
  echo "Invalid release tag format: $TAG (expected vX.Y.Z or vX.Y.Z-beta.1)" >&2
  exit 1
fi

if ! gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG not found; the release job must create it before finalization" >&2
  exit 1
fi

echo "Marking $TAG as the latest release..."
gh release edit "$TAG" -R "$REPO" --draft=false --prerelease=false --latest

LATEST_TAG="$(gh api "repos/${REPO}/releases/latest" --jq '.tag_name' 2>/dev/null || true)"
if [[ "$LATEST_TAG" != "$TAG" ]]; then
  echo "Expected $TAG to be the latest release, but GitHub reports '${LATEST_TAG:-<none>}'" >&2
  exit 1
fi

echo "Release $TAG is now the latest release."

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  RELEASE_URL="$(gh api "repos/${REPO}/releases/tags/${TAG}" --jq '.html_url' 2>/dev/null || echo "")"
  {
    echo "## Desktop release finalized"
    echo "- Tag: \`$TAG\`"
    echo "- Marked as latest: ✅"
    [[ -n "$RELEASE_URL" ]] && echo "- Release URL: $RELEASE_URL"
  } >> "$GITHUB_STEP_SUMMARY"
fi
