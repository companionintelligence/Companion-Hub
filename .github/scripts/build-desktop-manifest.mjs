#!/usr/bin/env node
// Write a desktop release's manifest.json: each installer's download URL, size and SHA-256.
//
// The desktop app installs only what a signed manifest names (packages/desktop/src-tauri/src/
// update_signature.rs), so this runs in Desktop Release's `sign-manifest` job, beside the signing
// key and away from the R2 upload token. `upload-r2` uploads the result as it is.
//
// Usage: build-desktop-manifest.mjs <artifacts dir> <output file>
// Env:   RELEASE_TAG (v0.3.14), DOWNLOAD_BASE_URL (https://dl.ci.computer), DATE (optional, ISO 8601)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [artifactsDir, outFile] = process.argv.slice(2);
const { RELEASE_TAG, DOWNLOAD_BASE_URL, DATE } = process.env;
if (!artifactsDir || !outFile || !RELEASE_TAG || !DOWNLOAD_BASE_URL) {
  console.error('usage: RELEASE_TAG=… DOWNLOAD_BASE_URL=… build-desktop-manifest.mjs <artifacts dir> <output file>');
  process.exit(2);
}

const VERSION = RELEASE_TAG;
const baseUrl = DOWNLOAD_BASE_URL.replace(/\/+$/, '');
const manifest = {
  version: VERSION.replace(/^v/, ''),
  date: DATE || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
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
  const dir = path.join(artifactsDir, artifactDir);
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir);
  const platformData = {};
  for (const [fmt, ext] of Object.entries(formats)) {
    const file = files.find((f) => f.endsWith(ext));
    if (!file) continue;
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    // Windows points at the space-free copy upload-desktop-r2.sh puts up (see `upload_windows` there).
    const windows = platform.startsWith('windows');
    const encodedFile = encodeURIComponent(windows ? file.replace(/ /g, '.') : file);
    if (windows && encodedFile.includes('%')) {
      throw new Error(`${file}: a % in a Windows installer URL stops the desktop app's updater from running it`);
    }
    let r2Path;
    if (platform === 'windows-aarch64') r2Path = 'windows/arm64';
    else if (platform.startsWith('windows')) r2Path = 'windows/x64';
    else if (platform === 'darwin-aarch64') r2Path = 'macos/arm';
    else if (platform === 'darwin-x86_64') r2Path = 'macos/intel';
    else if (platform === 'linux-x86_64') r2Path = `linux/${fmt}/x64`;
    else r2Path = `linux/${fmt}/arm`;
    platformData[fmt] = {
      url: `${baseUrl}/${VERSION}/${r2Path}/${encodedFile}`,
      size: stat.size,
      sha256,
    };
  }
  if (Object.keys(platformData).length > 0) {
    manifest.platforms[platform] = platformData;
  }
}

fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
