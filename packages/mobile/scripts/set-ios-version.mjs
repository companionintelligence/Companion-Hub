#!/usr/bin/env node
/**
 * Stamp the iOS marketing version and build number into every committed source
 * that can feed the bundle: Tauri config, XcodeGen project.yml, and Info.plist.
 *
 * `tauri ios build` applies `bundle.iOS.bundleVersion` from tauri.conf.json,
 * while Xcode copies the committed Info.plist. Updating only project.yml does
 * not guarantee the values in the IPA, so all three sources stay in sync.
 *
 * Usage:
 *   IOS_BUILD_NUMBER=20261027.123.1 node scripts/set-ios-version.mjs
 *   IOS_BUILD_NUMBER=20261027.123.1 node scripts/set-ios-version.mjs --check
 *   node scripts/set-ios-version.mjs --check
 *
 * Without IOS_BUILD_NUMBER, local simulator builds retain their existing build
 * number and only the marketing version is synchronized.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const TAURI_CONF = path.join(mobileRoot, 'src-tauri/tauri.conf.json');
const PROJECT_YML = path.join(mobileRoot, 'src-tauri/gen/apple/project.yml');
const INFO_PLIST = path.join(mobileRoot, 'src-tauri/gen/apple/ci-os-hub-mobile_iOS/Info.plist');
const checkOnly = process.argv.includes('--check');

function readTauriConfig() {
  return JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
}

function marketingVersion(config) {
  const version = config.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`tauri.conf.json has no usable "version" (got ${JSON.stringify(version)})`);
  }
  return version;
}

/** Replace a scalar under the XcodeGen `properties:` map, preserving style. */
function setProjectProperty(yaml, key, value) {
  const pattern = new RegExp(`^(\\s*)${key}:[ \\t]*.*$`, 'm');
  if (!pattern.test(yaml)) {
    throw new Error(`${key} not found in ${PROJECT_YML} — did the generator layout change?`);
  }
  return yaml.replace(pattern, `$1${key}: "${value}"`);
}

function readProjectProperty(yaml, key) {
  return yaml.match(new RegExp(`^\\s*${key}:[ \\t]*"?([^"\\n]+)"?\\s*$`, 'm'))?.[1] ?? null;
}

/** Update/read the string directly following a plist <key>. */
function setPlistString(plist, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  const pattern = new RegExp(`(<key>${escapedKey}</key>\\s*<string>)[^<]*(</string>)`);
  if (!pattern.test(plist)) {
    throw new Error(`${key} not found in ${INFO_PLIST} — did the generated plist layout change?`);
  }
  return plist.replace(pattern, `$1${value}$2`);
}

function readPlistString(plist, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  return plist.match(new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? null;
}

function validateBuildNumber(buildNumber) {
  if (!/^\d+(?:\.\d+){0,2}$/.test(buildNumber)) {
    throw new Error(`IOS_BUILD_NUMBER must be 1-3 dot-separated integers, got "${buildNumber}"`);
  }
}

const config = readTauriConfig();
const version = marketingVersion(config);
const buildNumber = process.env.IOS_BUILD_NUMBER?.trim();
let project = readFileSync(PROJECT_YML, 'utf8');
let plist = readFileSync(INFO_PLIST, 'utf8');

function reportAndCheck() {
  const projectVersion = readProjectProperty(project, 'CFBundleShortVersionString');
  const plistVersion = readPlistString(plist, 'CFBundleShortVersionString');
  const projectBuild = readProjectProperty(project, 'CFBundleVersion');
  const plistBuild = readPlistString(plist, 'CFBundleVersion');
  const configBuild = config.bundle?.iOS?.bundleVersion ?? null;

  console.log(`tauri.conf.json version      : ${version}`);
  console.log(`project.yml version           : ${projectVersion}`);
  console.log(`Info.plist version            : ${plistVersion}`);
  console.log(`tauri.conf.json build         : ${configBuild ?? '(unset)'}`);
  console.log(`project.yml build             : ${projectBuild}`);
  console.log(`Info.plist build              : ${plistBuild}`);

  const errors = [];
  if (projectVersion !== version) errors.push(`project.yml version ${projectVersion} does not match ${version}`);
  if (plistVersion !== version) errors.push(`Info.plist version ${plistVersion} does not match ${version}`);
  if (projectBuild !== plistBuild) errors.push(`project.yml build ${projectBuild} does not match Info.plist ${plistBuild}`);
  if (configBuild !== null && String(configBuild) !== projectBuild) {
    errors.push(`tauri.conf.json build ${configBuild} does not match project.yml ${projectBuild}`);
  }
  if (buildNumber) {
    validateBuildNumber(buildNumber);
    if (projectBuild !== buildNumber) errors.push(`project.yml build ${projectBuild} does not match requested ${buildNumber}`);
    if (plistBuild !== buildNumber) errors.push(`Info.plist build ${plistBuild} does not match requested ${buildNumber}`);
    if (String(configBuild) !== buildNumber) errors.push(`tauri.conf.json build ${configBuild} does not match requested ${buildNumber}`);
  }
  if (errors.length) {
    for (const error of errors) console.error(`✗ ${error}`);
    process.exit(1);
  }
  console.log('\n✓ iOS version and build sources are in sync');
}

if (checkOnly) {
  reportAndCheck();
  process.exit(0);
}

project = setProjectProperty(project, 'CFBundleShortVersionString', version);
plist = setPlistString(plist, 'CFBundleShortVersionString', version);

if (buildNumber) {
  validateBuildNumber(buildNumber);
  config.bundle ??= {};
  config.bundle.iOS ??= {};
  config.bundle.iOS.bundleVersion = buildNumber;
  project = setProjectProperty(project, 'CFBundleVersion', buildNumber);
  plist = setPlistString(plist, 'CFBundleVersion', buildNumber);
  writeFileSync(TAURI_CONF, `${JSON.stringify(config, null, 2)}\n`);
}

writeFileSync(PROJECT_YML, project);
writeFileSync(INFO_PLIST, plist);
console.log(`iOS version stamped: ${version} (build ${buildNumber ?? 'unchanged — no IOS_BUILD_NUMBER'})`);
