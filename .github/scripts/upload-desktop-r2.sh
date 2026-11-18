#!/usr/bin/env bash
# Upload desktop release installers + manifest + latest.json to an R2 bucket.
#
# Required env:
#   R2_BUCKET          — e.g. dl-prod or dl-dev
#   DOWNLOAD_BASE_URL  — public HTTPS origin, e.g. https://dl.ci.computer
#   RELEASE_TAG        — e.g. v0.2.34
#   MANIFEST_DIR       — manifest.json and manifest.json.sig from the sign-manifest job
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID — wrangler auth
#
# The manifest is built and signed in another job, which has the signing key and not this token
# (build-desktop-manifest.mjs, sign-desktop-manifest.mjs). It is uploaded here byte for byte: the
# desktop app refuses a manifest whose signature does not match.
set -euo pipefail

: "${R2_BUCKET:?R2_BUCKET is required}"
: "${DOWNLOAD_BASE_URL:?DOWNLOAD_BASE_URL is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${MANIFEST_DIR:?MANIFEST_DIR is required}"
MANIFEST="${MANIFEST_DIR}/manifest.json"
[ -s "${MANIFEST}" ] || { echo "::error::${MANIFEST} is missing"; exit 1; }
[ -s "${MANIFEST}.sig" ] || { echo "::error::${MANIFEST}.sig is missing: desktop apps refuse an unsigned manifest"; exit 1; }

# The signed manifest must describe these very files, or every desktop would refuse the download.
node - "${MANIFEST}" <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const local = new Map();
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(dmg|msi|exe|deb|rpm)$/.test(entry.name)) {
      local.set(crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'), fs.statSync(full).size);
    }
  }
};
walk('artifacts');
for (const [platform, formats] of Object.entries(manifest.platforms || {})) {
  for (const [format, { sha256, size }] of Object.entries(formats)) {
    if (local.get(sha256) !== size) {
      console.error(`::error::manifest.json names a ${platform} ${format} (${sha256}) that is not among the artifacts being uploaded`);
      process.exit(1);
    }
  }
}
NODE

DOWNLOAD_BASE_URL="${DOWNLOAD_BASE_URL%/}"
VERSION="${RELEASE_TAG}"
DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

upload() {
  wrangler r2 object put --remote "${R2_BUCKET}/$1" --file "$2"
}

# Windows installers also go up under a name without spaces, GitHub's own spelling
# ("Companion.Hub_…"), and the manifest points at that copy. The desktop app's Windows updater up to
# 0.3.5 saves the installer under the URL's last segment, still percent-encoded, and runs it from a
# .cmd script where the `%2` of `%20` reads as a batch argument, so a URL with a space never
# installs. The original names stay for the links on the website and in the docs.
upload_windows() {
  local name cdn_name
  name="$(basename "$2")"
  cdn_name="${name// /.}"
  upload "$1/${name}" "$2"
  if [ "$cdn_name" != "$name" ]; then
    upload "$1/${cdn_name}" "$2"
  fi
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
  [ -f "$f" ] && upload_windows "${VERSION}/windows/x64" "$f"
done
for f in artifacts/release-x86_64-pc-windows-msvc/*-setup.exe; do
  [ -f "$f" ] && upload_windows "${VERSION}/windows/x64" "$f"
done

# Windows ARM64
for f in artifacts/release-aarch64-pc-windows-msvc/*.msi; do
  [ -f "$f" ] && upload_windows "${VERSION}/windows/arm64" "$f"
done
for f in artifacts/release-aarch64-pc-windows-msvc/*-setup.exe; do
  [ -f "$f" ] && upload_windows "${VERSION}/windows/arm64" "$f"
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


# The signature first: a client that finds the manifest must find its signature too.
upload "${VERSION}/manifest.json.sig" "${MANIFEST}.sig"
upload "${VERSION}/manifest.json" "${MANIFEST}"

# On production, the root latest.json is what stable clients follow, so it moves to this version only
# when the manifest has every key in REQUIRED_PLATFORMS. A partial run (for example a prerelease
# dispatch with platforms=linux-windows) then leaves production on the previous version. The
# per-version manifest above is uploaded either way, and the dev bucket always repoints as before.
REQUIRED_PLATFORMS=(darwin-aarch64 darwin-x86_64 windows-x86_64 linux-x86_64)
missing_platforms=""
if [ "${R2_BUCKET}" = "dl-prod" ]; then
  missing_platforms="$(MANIFEST="${MANIFEST}" node -e '
    const fs = require("fs");
    const required = process.argv.slice(1);
    const { platforms = {} } = JSON.parse(fs.readFileSync(process.env.MANIFEST, "utf8"));
    console.log(required.filter((p) => !platforms[p]).join(" "));
  ' "${REQUIRED_PLATFORMS[@]}")"
fi

if [ -n "${missing_platforms}" ]; then
  echo "::warning::Not repointing production latest.json to ${VERSION}; manifest is missing: ${missing_platforms}"
  echo "Per-version manifest is at ${DOWNLOAD_BASE_URL}/${VERSION}/manifest.json; ${DOWNLOAD_BASE_URL}/latest.json is unchanged."
else
  echo "{\"version\":\"${VERSION}\",\"date\":\"${DATE}\"}" > /tmp/latest.json
  wrangler r2 object put --remote "${R2_BUCKET}/latest.json" --file /tmp/latest.json
  echo "Done. Feed: ${DOWNLOAD_BASE_URL}/latest.json"
fi
