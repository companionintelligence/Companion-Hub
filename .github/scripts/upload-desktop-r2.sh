#!/usr/bin/env bash
# Upload desktop release installers + manifest + latest.json to an R2 bucket.
#
# Required env:
#   R2_BUCKET          — e.g. dl-prod or dl-dev
#   DOWNLOAD_BASE_URL  — public HTTPS origin, e.g. https://dl.ci.computer
#   RELEASE_TAG        — e.g. v0.2.34
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID — wrangler auth
set -euo pipefail

: "${R2_BUCKET:?R2_BUCKET is required}"
: "${DOWNLOAD_BASE_URL:?DOWNLOAD_BASE_URL is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"

DOWNLOAD_BASE_URL="${DOWNLOAD_BASE_URL%/}"
VERSION="${RELEASE_TAG}"
SEMVER="${VERSION#v}"
DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

upload() {
  wrangler r2 object put --remote "${R2_BUCKET}/$1" --file "$2"
}

echo "Uploading desktop release ${VERSION} to R2 bucket ${R2_BUCKET} (CDN ${DOWNLOAD_BASE_URL})"

# macOS
for f in artifacts/release-aarch64-apple-darwin/*.dmg; do
  [ -f "$f" ] && upload "${VERSION}/macos/arm/$(basename "$f")" "$f"
done
for f in artifacts/release-x86_64-apple-darwin/*.dmg; do
  [ -f "$f" ] && upload "${VERSION}/macos/intel/$(basename "$f")" "$f"
done

# Windows x64
for f in artifacts/release-x86_64-pc-windows-msvc/*.msi; do
  [ -f "$f" ] && upload "${VERSION}/windows/x64/$(basename "$f")" "$f"
done
for f in artifacts/release-x86_64-pc-windows-msvc/*-setup.exe; do
  [ -f "$f" ] && upload "${VERSION}/windows/x64/$(basename "$f")" "$f"
done

# Windows ARM64
for f in artifacts/release-aarch64-pc-windows-msvc/*.msi; do
  [ -f "$f" ] && upload "${VERSION}/windows/arm64/$(basename "$f")" "$f"
done
for f in artifacts/release-aarch64-pc-windows-msvc/*-setup.exe; do
  [ -f "$f" ] && upload "${VERSION}/windows/arm64/$(basename "$f")" "$f"
done

# Linux x64
for f in artifacts/release-x86_64-unknown-linux-gnu/*.deb; do
  [ -f "$f" ] && upload "${VERSION}/linux/deb/x64/$(basename "$f")" "$f"
done
for f in artifacts/release-x86_64-unknown-linux-gnu/*.rpm; do
  [ -f "$f" ] && upload "${VERSION}/linux/rpm/x64/$(basename "$f")" "$f"
done

# Linux ARM64
for f in artifacts/release-aarch64-unknown-linux-gnu/*.deb; do
  [ -f "$f" ] && upload "${VERSION}/linux/deb/arm/$(basename "$f")" "$f"
done
for f in artifacts/release-aarch64-unknown-linux-gnu/*.rpm; do
  [ -f "$f" ] && upload "${VERSION}/linux/rpm/arm/$(basename "$f")" "$f"
done

export VERSION SEMVER DATE DOWNLOAD_BASE_URL
node <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { VERSION, SEMVER, DATE, DOWNLOAD_BASE_URL } = process.env;
const manifest = {
  version: SEMVER,
  date: DATE,
  platforms: {},
};

const mappings = [
  ['windows-x86_64', 'release-x86_64-pc-windows-msvc', { msi: '.msi', exe: '-setup.exe' }],
  ['windows-aarch64', 'release-aarch64-pc-windows-msvc', { msi: '.msi', exe: '-setup.exe' }],
  ['darwin-aarch64', 'release-aarch64-apple-darwin', { dmg: '.dmg' }],
  ['darwin-x86_64', 'release-x86_64-apple-darwin', { dmg: '.dmg' }],
  ['linux-x86_64', 'release-x86_64-unknown-linux-gnu', { deb: '.deb', rpm: '.rpm' }],
  ['linux-aarch64', 'release-aarch64-unknown-linux-gnu', { deb: '.deb', rpm: '.rpm' }],
];

for (const [platform, artifactDir, formats] of mappings) {
  const dir = path.join('artifacts', artifactDir);
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir);
  const platformData = {};
  for (const [fmt, ext] of Object.entries(formats)) {
    const file = files.find((f) => f.endsWith(ext));
    if (!file) continue;
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const encodedFile = encodeURIComponent(file);
    let r2Path;
    if (platform === 'windows-aarch64') r2Path = 'windows/arm64';
    else if (platform.startsWith('windows')) r2Path = 'windows/x64';
    else if (platform === 'darwin-aarch64') r2Path = 'macos/arm';
    else if (platform === 'darwin-x86_64') r2Path = 'macos/intel';
    else if (platform === 'linux-x86_64') r2Path = `linux/${fmt}/x64`;
    else r2Path = `linux/${fmt}/arm`;
    platformData[fmt] = {
      url: `${DOWNLOAD_BASE_URL}/${VERSION}/${r2Path}/${encodedFile}`,
      size: stat.size,
      sha256,
    };
  }
  if (Object.keys(platformData).length > 0) {
    manifest.platforms[platform] = platformData;
  }
}

fs.writeFileSync('/tmp/manifest.json', JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
NODE

wrangler r2 object put --remote "${R2_BUCKET}/${VERSION}/manifest.json" --file /tmp/manifest.json

echo "{\"version\":\"${VERSION}\",\"date\":\"${DATE}\"}" > /tmp/latest.json
wrangler r2 object put --remote "${R2_BUCKET}/latest.json" --file /tmp/latest.json

echo "Done. Feed: ${DOWNLOAD_BASE_URL}/latest.json"
