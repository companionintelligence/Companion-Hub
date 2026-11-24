#!/usr/bin/env bash
# Upload desktop release installers + manifest + latest.json to an R2 bucket.
#
# Required env:
#   R2_BUCKET          — e.g. dl-prod or dl-dev
#   DOWNLOAD_BASE_URL  — public HTTPS origin, e.g. https://dl.ci.computer
#   RELEASE_TAG        — e.g. v0.2.34
#   MANIFEST_DIR       — manifest.json and manifest.json.sig from the sign-manifest job
#   CLOUDFLARE_API_TOKEN — a Cloudflare API token with Workers R2 Storage Bucket Item Write on R2_BUCKET
#   CLOUDFLARE_ACCOUNT_ID — the account that owns R2_BUCKET
#
# Optional env:
#   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY — S3 credentials to use as they are, instead of deriving them
#                                            from CLOUDFLARE_API_TOKEN (see r2_credentials below)
#
# Uploads go through R2's S3 endpoint, not `wrangler r2 object put`. Wrangler writes through the
# Cloudflare REST API, which takes only the account-wide Workers R2 Storage permission, so a token
# limited to one bucket gets a 403 there. The S3 endpoint honours bucket-scoped tokens, which keeps
# the dev token from writing to dl-prod, whose latest.json is what stable clients follow.
#
# The manifest is built and signed in another job, which has the signing key and not this token
# (build-desktop-manifest.mjs, sign-desktop-manifest.mjs). It is uploaded here byte for byte: the
# desktop app refuses a manifest whose signature does not match.
set -euo pipefail

: "${R2_BUCKET:?R2_BUCKET is required}"
: "${DOWNLOAD_BASE_URL:?DOWNLOAD_BASE_URL is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${MANIFEST_DIR:?MANIFEST_DIR is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
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

# An API token's S3 credentials are its id (the access key) and the SHA-256 of its value (the secret):
# https://developers.cloudflare.com/r2/api/tokens/ ("Get S3 API credentials from an API token")
r2_credentials() {
  if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; then
    AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
    AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
  else
    : "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
    local verify id
    # An account-owned token verifies under its account, a user-owned one under /user.
    verify="$(curl -fsS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/tokens/verify" 2>/dev/null)" ||
      verify="$(curl -fsS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        "https://api.cloudflare.com/client/v4/user/tokens/verify" 2>/dev/null)" || {
        echo "::error::Cloudflare did not accept CLOUDFLARE_API_TOKEN (tokens/verify failed): check that the token exists, has not expired, and belongs to CLOUDFLARE_ACCOUNT_ID"
        exit 1
      }
    id="$(printf '%s' "${verify}" | node -e '
      const r = JSON.parse(require("fs").readFileSync(0, "utf8")).result || {};
      if (r.status !== "active") { console.error(`token status is ${r.status || "unknown"}`); process.exit(1); }
      console.log(r.id);
    ')" || { echo "::error::CLOUDFLARE_API_TOKEN is not active"; exit 1; }
    AWS_ACCESS_KEY_ID="${id}"
    AWS_SECRET_ACCESS_KEY="$(printf '%s' "${CLOUDFLARE_API_TOKEN}" | sha256sum | cut -d' ' -f1)"
  fi
  echo "::add-mask::${AWS_SECRET_ACCESS_KEY}"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  export AWS_DEFAULT_REGION=auto
  # AWS CLI 2.23+ adds CRC checksums R2 may not accept; send them only where S3 requires one.
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
}

R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

upload() {
  echo "Uploading ${R2_BUCKET}/$1"
  aws s3 cp "$2" "s3://${R2_BUCKET}/$1" --endpoint-url "${R2_ENDPOINT}" --no-progress --only-show-errors
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

r2_credentials
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
  upload latest.json /tmp/latest.json
  echo "Done. Feed: ${DOWNLOAD_BASE_URL}/latest.json"
fi
