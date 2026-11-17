#!/usr/bin/env bash
# Update Homebrew cask + Scoop manifest for a CI-Hub desktop release.
# Usage: ./distribution/scripts/update-package-manifests.sh v0.2.28
#
# Both manifests install from dl.ci.computer, the CDN behind the download page and the desktop updater, and take
# each installer's URL and sha256 from that release's manifest.json (written by .github/scripts/upload-desktop-r2.sh).
# They used to point at GitHub Releases, which answered 404 to anyone outside the org while the Hub repository was
# private. Run this after the release is uploaded: the publish job waits for upload-r2.
set -euo pipefail

BASE="${CI_HUB_DOWNLOAD_BASE:-https://dl.ci.computer}"
BASE="${BASE%/}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/distribution"
VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <tag>   e.g. v0.2.28" >&2
  exit 1
fi

TAG="${VERSION#v}"
VERSION="v${TAG}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

MANIFEST="$WORK/manifest.json"
echo "Reading $BASE/$VERSION/manifest.json ..."
curl -fsSL --retry 3 --retry-delay 5 "$BASE/$VERSION/manifest.json" -o "$MANIFEST"
if [[ "$(jq -r '.version' "$MANIFEST")" != "$TAG" ]]; then
  echo "$BASE/$VERSION/manifest.json is for version $(jq -r '.version' "$MANIFEST"), not $TAG" >&2
  exit 1
fi

# The cask and the Scoop manifest build their URLs from a version placeholder, so the URL the release really has
# must be the one the templates below produce. Checking it here stops a change to the uploader's layout before
# anything is published. The URL must also answer 200 without credentials (the bug this replaced) and have the
# size the manifest records. Progress goes to stderr: the sha256 is the only thing on stdout.
installer() {
  local platform="$1" format="$2" expected="$3" url size status length
  url="$(jq -r --arg p "$platform" --arg f "$format" '.platforms[$p][$f].url // empty' "$MANIFEST")"
  size="$(jq -r --arg p "$platform" --arg f "$format" '.platforms[$p][$f].size // empty' "$MANIFEST")"
  if [[ -z "$url" ]]; then
    echo "manifest.json has no $platform $format installer" >&2
    exit 1
  fi
  if [[ "$url" != "$expected" ]]; then
    echo "manifest.json lists $url for $platform $format; the templates in this script build $expected" >&2
    exit 1
  fi
  status="$(curl -sSI --retry 3 --retry-delay 5 -o "$WORK/headers" -w '%{http_code}' "$url")"
  if [[ "$status" != "200" ]]; then
    echo "HEAD $url answered $status, not 200" >&2
    exit 1
  fi
  length="$(tr -d '\r' <"$WORK/headers" | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }')"
  if [[ -n "$length" && "$length" != "$size" ]]; then
    echo "$url is $length bytes; manifest.json says $size" >&2
    exit 1
  fi
  echo "  ok  $platform $format ($url)" >&2
  jq -r --arg p "$platform" --arg f "$format" '.platforms[$p][$f].sha256' "$MANIFEST"
}

echo "Checking installers for $VERSION ..."
SHA_X64_DMG="$(installer darwin-x86_64 dmg "$BASE/$VERSION/macos/intel/Companion%20Hub_${TAG}_x64.dmg")"
SHA_AARCH64_DMG="$(installer darwin-aarch64 dmg "$BASE/$VERSION/macos/arm/Companion%20Hub_${TAG}_aarch64.dmg")"
SHA_X64_SETUP="$(installer windows-x86_64 exe "$BASE/$VERSION/windows/x64/Companion.Hub_${TAG}_x64-setup.exe")"

HOMEBREW="$DIST/homebrew/companion-hub.rb"
SCOOP="$DIST/scoop/companion-hub.json"

cat >"$HOMEBREW" <<RUBY
# Homebrew Cask formula for Companion Hub
# Published via: https://github.com/companionintelligence/homebrew-tap

cask "companion-hub" do
  version "${TAG}"

  on_intel do
    url "${BASE}/v#{version}/macos/intel/Companion%20Hub_#{version}_x64.dmg"
    sha256 "${SHA_X64_DMG}"
  end

  on_arm do
    url "${BASE}/v#{version}/macos/arm/Companion%20Hub_#{version}_aarch64.dmg"
    sha256 "${SHA_AARCH64_DMG}"
  end

  name "Companion Hub"
  desc "Self-hosted app platform and local AI hub from Companion Intelligence"
  homepage "https://ci.computer/hub"

  # latest.json is {"version":"v0.3.13","date":"..."}. It only moves to a version once that
  # release has an installer for every platform, so a version seen here is fully published.
  livecheck do
    url "${BASE}/latest.json"
    strategy :json do |json|
      json["version"]&.delete_prefix("v")
    end
  end

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

# Scoop variables, two kinds that look alike:
#  - installer.script is PowerShell that Scoop runs down the install_app call chain, so it reads that
#    function's variables ($dir, $version, $app, ...) by dynamic scoping. `$version_x64` is not one of
#    them: PowerShell takes the whole identifier, a variable named version_x64 that is undefined and
#    expands to nothing, so the script ran "Companion.Hub_-setup.exe". Braces end the name: `${version}_x64`.
#  - autoupdate.url is not run, it is rewritten by Scoop's substitute() with a plain string Replace of
#    `$version` (and `$dotVersion`, `$matchHead`, ...), longest key first and with no word boundary, so
#    `$version_x64` there becomes `<new version>_x64`. That one is correct and is left as it is.
# Checked against ScoopInstaller/Scoop lib/install.ps1 (install_app, Invoke-HookScript) and
# lib/autoupdate.ps1 + lib/core.ps1 (Get-VersionSubstitution, substitute) on 2026-10-13.
cat >"$SCOOP" <<JSON
{
  "version": "${TAG}",
  "description": "Self-hosted app platform and local AI hub from Companion Intelligence",
  "homepage": "https://ci.computer/hub",
  "license": "CI-Commercial-1.0",
  "url": "${BASE}/${VERSION}/windows/x64/Companion.Hub_${TAG}_x64-setup.exe",
  "hash": "${SHA_X64_SETUP}",
  "installer": {
    "script": "& \"\$dir\\\\Companion.Hub_\${version}_x64-setup.exe\" /S"
  },
  "uninstaller": {
    "script": [
      "# Scoop runs this uninstaller for both \`scoop uninstall\` and \`scoop update\`. An update must not stop",
      "# running apps, so the container cleanup below is skipped during an update. Scoop's update script is on",
      "# the call stack in that case, so the check looks for it. The cleanup only removes recreatable resources",
      "# (containers + networks) and never touches persistent data, so a plain uninstall stays safe.",
      "if (@(Get-PSCallStack | Where-Object { \$_.ScriptName -like '*scoop-update*' }).Count -gt 0) {",
      "  Write-Host 'Companion Hub: keeping its containers during a Scoop update.'",
      "  return",
      "}",
      "if (Get-Command docker -ErrorAction SilentlyContinue) {",
      "  # Windows PowerShell 5.1 drops double quotes inside a docker template, so the label name is a Go raw string in backticks.",
      "  \$managedProjects = @(",
      "    docker ps -a --filter 'label=ci-hub.managed=true' --format '{{.Label \`com.docker.compose.project\`}}' 2>\$null",
      "    docker ps -a --filter 'label=ci-os-hub.managed=true' --format '{{.Label \`com.docker.compose.project\`}}' 2>\$null",
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
      "  # App networks can go only once the ci-hub container attached to them is gone, so find them by label after the Hub pass.",
      "  foreach (\$label in @('com.docker.compose.project=ci-os-hub','com.docker.compose.project=ci-hub','ci-hub.managed=true','ci-os-hub.managed=true')) {",
      "    foreach (\$net in (docker network ls --filter \"label=\$label\" --format '{{.Name}}' 2>\$null)) { if (\$net -match '^[A-Za-z0-9][A-Za-z0-9_.-]*\$') { docker network rm \$net 2>\$null | Out-Null } }",
      "  }",
      "}"
    ]
  },
  "shortcuts": [["Companion Hub\\\\Companion Hub.exe", "Companion Hub"]],
  "checkver": {
    "url": "${BASE}/latest.json",
    "jsonpath": "\$.version",
    "regex": "v?([\\\\d.]+)"
  },
  "autoupdate": {
    "url": "${BASE}/v\$version/windows/x64/Companion.Hub_\$version_x64-setup.exe",
    "hash": {
      "url": "${BASE}/v\$version/manifest.json",
      "jsonpath": "\$.platforms['windows-x86_64'].exe.sha256"
    }
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
