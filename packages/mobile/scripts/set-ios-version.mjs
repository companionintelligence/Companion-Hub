#!/usr/bin/env node
/**
 * Stamp the iOS marketing version + build number into `gen/apple/project.yml`.
 *
 * Two different numbers, two different rules:
 *
 * - `CFBundleShortVersionString` (marketing, e.g. `0.1.0`) is what users see.
 *   Single-sourced from `tauri.conf.json` so iOS can't drift from Android,
 *   which already derives `versionName`/`versionCode` from the same field.
 * - `CFBundleVersion` (build number) must **strictly increase with every
 *   upload of a given marketing version**, or App Store Connect rejects the
 *   build ("The bundle version must be higher than the previously uploaded
 *   version"). It was previously the literal `0.1.0`, so the *second* upload
 *   of 0.1.0 could never succeed — including a re-upload after a rejection.
 *
 * Usage:
 *   IOS_BUILD_NUMBER=42 node scripts/set-ios-version.mjs      # CI
 *   node scripts/set-ios-version.mjs --check                  # verify only
 *
 * With no `IOS_BUILD_NUMBER`, the build number is left alone — local
 * simulator builds don't need one and shouldn't churn the tracked file.
 *
 * ⚠️ KNOWN GAP (verified 2026-09-05): this script writes ONLY `project.yml`, on
 * the assumption that xcodegen regenerates `Info.plist` from it during
 * `tauri ios build`. It does not — `gen/apple/Info.plist` is committed and is
 * what actually ships. Editing `project.yml` alone was observed to leave the
 * built `.app`'s CFBundleVersion untouched, which makes the stamping below a
 * no-op for the artifact you upload.
 *
 * Until that is fixed, this must also write the plist, e.g.
 *   plutil -replace CFBundleVersion -string "$IOS_BUILD_NUMBER" \
 *     src-tauri/gen/apple/ci-os-hub-mobile_iOS/Info.plist
 * See the README's "Generated Apple files are committed" note.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const TAURI_CONF = path.join(mobileRoot, 'src-tauri/tauri.conf.json');
const PROJECT_YML = path.join(mobileRoot, 'src-tauri/gen/apple/project.yml');

const checkOnly = process.argv.includes('--check');

/** Marketing version, single-sourced from tauri.conf.json. */
function marketingVersion() {
  const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
  const version = conf.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`tauri.conf.json has no usable "version" (got ${JSON.stringify(version)})`);
  }
  return version;
}

/**
 * Replace a scalar under the `properties:` map. Anchored to the exact key at
 * line start so a value that happens to contain the key name can't match, and
 * the file's existing indentation/quoting style is preserved.
 */
function setPlistProperty(yaml, key, value) {
  const pattern = new RegExp(`^(\\s*)${key}:[ \\t]*.*$`, 'm');
  if (!pattern.test(yaml)) {
    throw new Error(`${key} not found in ${PROJECT_YML} — did the generator layout change?`);
  }
  // Always quote: an unquoted 0.1.0 is fine but a bare build number like
  // `20260803` would parse as an int and xcodegen would emit a non-string.
  return yaml.replace(pattern, `$1${key}: "${value}"`);
}

function readProperty(yaml, key) {
  return yaml.match(new RegExp(`^\\s*${key}:[ \\t]*"?([^"\\n]+)"?\\s*$`, 'm'))?.[1] ?? null;
}

const version = marketingVersion();
const buildNumber = process.env.IOS_BUILD_NUMBER?.trim();
let yaml = readFileSync(PROJECT_YML, 'utf8');

if (checkOnly) {
  const short = readProperty(yaml, 'CFBundleShortVersionString');
  const build = readProperty(yaml, 'CFBundleVersion');
  console.log(`tauri.conf.json version      : ${version}`);
  console.log(`CFBundleShortVersionString   : ${short}`);
  console.log(`CFBundleVersion              : ${build}`);
  if (short !== version) {
    console.error(`\n✗ marketing version drift: project.yml has ${short}, tauri.conf.json has ${version}`);
    process.exit(1);
  }
  console.log('\n✓ marketing version is in sync');
  process.exit(0);
}

yaml = setPlistProperty(yaml, 'CFBundleShortVersionString', version);
if (buildNumber) {
  if (!/^\d+$/.test(buildNumber)) {
    // ASC compares build numbers as dot-separated integers; a monotonic plain
    // integer (a CI run number) is the simplest thing that always compares right.
    throw new Error(`IOS_BUILD_NUMBER must be a positive integer, got "${buildNumber}"`);
  }
  yaml = setPlistProperty(yaml, 'CFBundleVersion', buildNumber);
}

writeFileSync(PROJECT_YML, yaml);
console.log(`iOS version stamped: ${version} (build ${buildNumber ?? 'unchanged — no IOS_BUILD_NUMBER'})`);
