#!/usr/bin/env bash
# Update Homebrew cask + Scoop manifest for a CI-Hub desktop release.
# Usage: ./distribution/scripts/update-package-manifests.sh v0.2.28
set -euo pipefail

REPO="${CI_HUB_RELEASE_REPO:-companionintelligence/CI-Hub}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/distribution"
VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <tag>   e.g. v0.2.28" >&2
  exit 1
fi

TAG="${VERSION#v}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

hash_asset() {
  local pattern="$1"
  gh release download "$VERSION" --repo "$REPO" -D "$WORK" -p "$pattern"
  local file
  file="$(find "$WORK" -maxdepth 1 -name "$pattern" -print -quit)"
  if [[ -z "$file" ]]; then
    echo "Asset not found: $pattern" >&2
    exit 1
  fi
  shasum -a 256 "$file" | awk '{print $1}'
}

echo "Hashing release assets for $VERSION ..."
SHA_X64_DMG="$(hash_asset "Companion.Hub_${TAG}_x64.dmg")"
SHA_AARCH64_DMG="$(hash_asset "Companion.Hub_${TAG}_aarch64.dmg")"
SHA_X64_SETUP="$(hash_asset "Companion.Hub_${TAG}_x64-setup.exe")"

HOMEBREW="$DIST/homebrew/companion-hub.rb"
SCOOP="$DIST/scoop/companion-hub.json"

cat >"$HOMEBREW" <<RUBY
# Homebrew Cask formula for Companion Hub
# Published via: https://github.com/companionintelligence/homebrew-tap

cask "companion-hub" do
  version "${TAG}"

  on_intel do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_x64.dmg"
    sha256 "${SHA_X64_DMG}"
  end

  on_arm do
    url "https://github.com/companionintelligence/CI-Hub/releases/download/v#{version}/Companion.Hub_#{version}_aarch64.dmg"
    sha256 "${SHA_AARCH64_DMG}"
  end

  name "Companion Hub"
  desc "Self-hosted app platform and local AI hub from Companion Intelligence"
  homepage "https://ci.computer/hub"

  app "Companion Hub.app"

  # The desktop keeps its data in Application Support/companion-hub and its Cloudflare
  # tunnel token in Application Support/tunnel, beside the data folder. "tunnel" is a
  # generic name, so zap trashes only the files the Hub writes there and removes the
  # folder (and the empty certs folder the Hub creates) only when nothing else is left.
  zap trash: [
        "~/Library/Application Support/companion-hub",
        "~/Library/Application Support/computer.ci.app.hub",
        "~/Library/Application Support/tunnel/.user-cleared-token",
        "~/Library/Application Support/tunnel/leftover.json",
        "~/Library/Application Support/tunnel/registration.json",
        "~/Library/Application Support/tunnel/token",
        "~/Library/Caches/computer.ci.app.hub",
        "~/Library/Preferences/computer.ci.app.hub.plist",
        "~/Library/Saved Application State/computer.ci.app.hub.savedState",
        "~/Library/WebKit/computer.ci.app.hub",
      ],
      rmdir: "~/Library/Application Support/tunnel"
end
RUBY

cat >"$SCOOP" <<JSON
{
  "version": "${TAG}",
  "description": "Self-hosted app platform and local AI hub from Companion Intelligence",
  "homepage": "https://ci.computer/hub",
  "license": "CI-Commercial-1.0",
  "url": "https://github.com/companionintelligence/CI-Hub/releases/download/v${TAG}/Companion.Hub_${TAG}_x64-setup.exe",
  "hash": "${SHA_X64_SETUP}",
  "installer": {
    "script": "& \"\$dir\\\\Companion.Hub_\$version_x64-setup.exe\" /S"
  },
  "uninstaller": {
    "script": [
      "# IMPORTANT: Scoop runs this uninstaller during \`scoop update\` as well as \`scoop uninstall\`,",
      "# and it gives the script no way to tell the two apart. So this script must only remove",
      "# recreatable resources (containers + networks) and must NOT touch persistent data — otherwise",
      "# every \`scoop update companion-hub\` would wipe the user's database and app state.",
      "if (Get-Command docker -ErrorAction SilentlyContinue) {",
      "  \$managedProjects = @(",
      "    docker ps -a --filter 'label=ci-hub.managed=true' --format '{{.Label \"com.docker.compose.project\"}}' 2>\$null",
      "    docker ps -a --filter 'label=ci-os-hub.managed=true' --format '{{.Label \"com.docker.compose.project\"}}' 2>\$null",
      "  ) | Where-Object { \$_ -and \$_.Trim().Length -gt 0 } | Select-Object -Unique",
      "  foreach (\$project in \$managedProjects) {",
      "    if (\$project -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*\$') { continue }",
      "    if (\$project -in @('ci-os-hub','ci-hub')) { continue }",
      "    foreach (\$cid in (docker ps -a --filter \"label=com.docker.compose.project=\$project\" --format '{{.ID}}' 2>\$null)) { if (\$cid) { docker rm -f \$cid 2>\$null | Out-Null } }",
      "    foreach (\$net in (docker network ls --filter \"label=com.docker.compose.project=\$project\" --format '{{.Name}}' 2>\$null)) { if (\$net -and \$net -notin @('bridge','host','none','ci_hub_network','ci-hub_network','ci_os_hub_network','ci-os-hub_network')) { docker network rm \$net 2>\$null | Out-Null } }",
      "  }",
      "  \$containerNames = @()",
      "  \$containerNames += docker ps -a --filter 'label=com.docker.compose.project=ci-os-hub' --format '{{.Names}}' 2>\$null",
      "  \$containerNames += docker ps -a --filter 'label=com.docker.compose.project=ci-hub' --format '{{.Names}}' 2>\$null",
      "  \$containerNames += docker ps -a --filter 'network=ci_hub_network' --format '{{.Names}}' 2>\$null",
      "  \$containerNames += docker ps -a --filter 'network=ci-hub_network' --format '{{.Names}}' 2>\$null",
      "  \$containerNames += docker ps -a --filter 'network=ci_os_hub_network' --format '{{.Names}}' 2>\$null",
      "  \$containerNames += docker ps -a --filter 'network=ci-os-hub_network' --format '{{.Names}}' 2>\$null",
      "  \$containerNames = \$containerNames | Where-Object { \$_ -and \$_.Trim().Length -gt 0 } | Select-Object -Unique",
      "  foreach (\$name in \$containerNames) { docker rm -f \$name 2>\$null | Out-Null }",
      "  docker network rm ci_hub_network ci-hub_network ci_os_hub_network ci-os-hub_network 2>\$null | Out-Null",
      "}"
    ]
  },
  "shortcuts": [["Companion Hub\\\\Companion Hub.exe", "Companion Hub"]],
  "checkver": {
    "github": "https://github.com/companionintelligence/CI-Hub"
  },
  "autoupdate": {
    "url": "https://github.com/companionintelligence/CI-Hub/releases/download/v\$version/Companion.Hub_\$version_x64-setup.exe"
  }
}
JSON

# Publish-ready copies for companionintelligence/homebrew-tap and scoop-bucket repos.
mkdir -p "$DIST/publish/homebrew-tap/Casks" "$DIST/publish/scoop-bucket"
cp "$HOMEBREW" "$DIST/publish/homebrew-tap/Casks/companion-hub.rb"
cp "$SCOOP" "$DIST/publish/scoop-bucket/companion-hub.json"

echo "Updated:"
echo "  $HOMEBREW"
echo "  $SCOOP"
echo "  $DIST/publish/homebrew-tap/Casks/companion-hub.rb"
echo "  $DIST/publish/scoop-bucket/companion-hub.json"
