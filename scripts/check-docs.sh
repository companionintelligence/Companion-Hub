#!/usr/bin/env bash
set -o errexit
set -o nounset
set -o pipefail

cd "$(dirname "$0")/.."

required_files=(
  README.md
  CI-CD-PIPELINE.md
  docs/DEVELOPER-SETUP.md
  docs/RELEASE-ARCHITECTURE.md
  docs/COMPATIBILITY-NOTES.md
  packages/common/README.md
)

for file in "${required_files[@]}"; do
  [[ -f "$file" ]] || {
    echo "Missing required documentation file: $file"
    exit 1
  }
done

grep -Fq 'docs/DEVELOPER-SETUP.md' README.md
grep -Fq 'docs/RELEASE-ARCHITECTURE.md' README.md
grep -Fq 'docs/COMPATIBILITY-NOTES.md' README.md
grep -Fq 'docs/RELEASE-ARCHITECTURE.md' CI-CD-PIPELINE.md
grep -Fq '@ci-hub/common' packages/common/README.md

grep -Fq 'name: Build and Publish Hub Container' .github/workflows/build-container.yml
grep -Fq 'name: Publish Hub Release' .github/workflows/release.yml
grep -Fq 'name: Tag Staging Release' .github/workflows/semver-tag.yml
grep -Fq 'name: Integration Tests' .github/workflows/integration-tests.yml

if rg -n 'Companion Home|CI-OS-Hub\.git' README.md docs/DEVELOPER-SETUP.md docs/RELEASE-ARCHITECTURE.md CI-CD-PIPELINE.md >/dev/null; then
  echo 'Found stale end-user or operator naming in the updated docs surface.'
  exit 1
fi

grep -Fq '# `@ci-hub/common`' packages/common/README.md
grep -Fq 'legacy compatibility-era naming' packages/common/README.md

if grep -Fq 'Companion Home' scripts/install.sh; then
  echo 'Installer still uses stale Companion Home product copy.'
  exit 1
fi

echo 'Documentation checks passed.'
