import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the CI-Hub mobile app metadata for consistency across the Tauri config
 * (source of truth) and the generated native iOS / Android project files.
 *
 * The user hit "wrong app metadata" on the iOS + Android simulators. The failure
 * modes this test locks down (some seen historically — e.g. Android strings.xml
 * once wrapped the label in literal quotes: `"Companion Hub"`):
 *   - the human-facing app / display name drifting or picking up stray quote chars
 *   - the iOS bundle id drifting from computer.ci.app.hub, or Android
 *     applicationId drifting from the Play-registered com.companionintelligence.hub
 *   - version strings disagreeing across tauri.conf.json, iOS, and Android
 *   - the `cihub` deep-link scheme missing on one platform
 *   - the iOS deployment target slipping off iOS 16
 *
 * Files are parsed with plain fs + small regex/JSON helpers (no plist/XML deps).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ -> frontend -> packages -> packages/mobile/src-tauri
const TAURI = path.resolve(here, '../../mobile/src-tauri');

const EXPECTED_NAME = 'Companion Hub';
const EXPECTED_ID = 'computer.ci.app.hub';
/** Google Play package — registered separately from the Tauri/iOS identifier. */
const EXPECTED_ANDROID_APPLICATION_ID = 'com.companionintelligence.hub';
const EXPECTED_SCHEME = 'cihub';
const EXPECTED_IOS_TARGET = '16.0';

function read(rel: string): string {
  return readFileSync(path.join(TAURI, rel), 'utf8');
}

/** First capture group of `re` in `content`, trimmed; throws with `label` if absent. */
function grab(content: string, re: RegExp, label: string): string {
  const m = content.match(re);
  if (!m) throw new Error(`could not find ${label}`);
  return (m[1] ?? '').trim();
}

/** Value of a `<key>…</key><string>…</string>` pair in an Apple plist. */
function plistString(content: string, key: string): string {
  return grab(content, new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`), `plist key ${key}`);
}

// --- Load every metadata source once ---------------------------------------

const tauriConf = JSON.parse(read('tauri.conf.json')) as {
  productName: string;
  version: string;
  identifier: string;
  app: { windows: Array<{ title: string }> };
  bundle: { iOS: { minimumSystemVersion: string } };
  plugins: { 'deep-link': { mobile: Array<{ scheme?: string[]; host?: string }>; desktop: { schemes: string[] } } };
};

const iosProjectYml = read('gen/apple/project.yml');
const iosInfoPlist = read('gen/apple/ci-os-hub-mobile_iOS/Info.plist');
const androidManifest = read('gen/android/app/src/main/AndroidManifest.xml');
const androidStrings = read('gen/android/app/src/main/res/values/strings.xml');
const androidGradle = read('gen/android/app/build.gradle.kts');
// NB: the Android versionName/Code live in `gen/android/app/tauri.properties`,
// which is generated from tauri.conf at build time and NOT committed — so we
// can't read it in CI. The version consistency is covered via tauri.conf + iOS.

// Extracted native values
const iosProductName = grab(iosProjectYml, /PRODUCT_NAME:\s*(.+)/, 'iOS PRODUCT_NAME');
const iosBundleId = grab(iosProjectYml, /PRODUCT_BUNDLE_IDENTIFIER:\s*(\S+)/, 'iOS PRODUCT_BUNDLE_IDENTIFIER');
const iosYmlShortVersion = grab(iosProjectYml, /CFBundleShortVersionString:\s*"?([\d.]+)"?/, 'iOS project.yml CFBundleShortVersionString');
const iosYmlBundleVersion = grab(iosProjectYml, /CFBundleVersion:\s*"?([\d.]+)"?/, 'iOS project.yml CFBundleVersion');
const iosDeploymentTarget = grab(iosProjectYml, /deploymentTarget:[\s\S]*?iOS:\s*"?([\d.]+)"?/, 'iOS deploymentTarget');

const androidAppName = grab(androidStrings, /<string name="app_name">([^<]*)<\/string>/, 'android app_name');
const androidActivityTitle = grab(androidStrings, /<string name="main_activity_title">([^<]*)<\/string>/, 'android main_activity_title');
const androidApplicationId = grab(androidGradle, /applicationId\s*=\s*"([^"]+)"/, 'android applicationId');
const androidNamespace = grab(androidGradle, /namespace\s*=\s*"([^"]+)"/, 'android namespace');

// --- Tests -----------------------------------------------------------------

describe('mobile app metadata: display name', () => {
  it('is "Companion Hub" everywhere, with no stray quote characters', () => {
    // Source of truth
    expect(tauriConf.productName).toBe(EXPECTED_NAME);
    expect(tauriConf.app.windows[0]?.title).toBe(EXPECTED_NAME);
    // iOS: Info.plist CFBundleName is driven by project.yml PRODUCT_NAME
    expect(plistString(iosInfoPlist, 'CFBundleName')).toBe('$(PRODUCT_NAME)');
    expect(iosProductName).toBe(EXPECTED_NAME);
    // Android: launcher + activity label
    expect(androidAppName).toBe(EXPECTED_NAME);
    expect(androidActivityTitle).toBe(EXPECTED_NAME);
    expect(androidManifest).toMatch(/android:label="@string\/app_name"/);

    // Regression guard: the label must not carry literal quote chars
    // (Android strings.xml once shipped `"Companion Hub"`).
    for (const label of [androidAppName, androidActivityTitle, tauriConf.productName, iosProductName]) {
      expect(label).not.toMatch(/["']/);
    }
  });
});

describe('mobile app metadata: bundle identifier', () => {
  it('keeps Tauri/iOS on computer.ci.app.hub and Android applicationId on Play id', () => {
    expect(tauriConf.identifier).toBe(EXPECTED_ID);
    // iOS: Info.plist CFBundleIdentifier is driven by project.yml PRODUCT_BUNDLE_IDENTIFIER
    expect(plistString(iosInfoPlist, 'CFBundleIdentifier')).toBe('$(PRODUCT_BUNDLE_IDENTIFIER)');
    expect(iosBundleId).toBe(EXPECTED_ID);
    // Android: Play Console requires com.companionintelligence.hub; namespace may
    // stay on the Tauri identifier (R class / generated Kotlin package).
    expect(androidApplicationId).toBe(EXPECTED_ANDROID_APPLICATION_ID);
    expect(androidNamespace).toBe(EXPECTED_ID);
  });
});

describe('mobile app metadata: version', () => {
  it('agrees across tauri.conf, iOS project.yml, iOS Info.plist, and Android', () => {
    const version = tauriConf.version;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    // iOS project.yml
    expect(iosYmlShortVersion).toBe(version);
    expect(iosYmlBundleVersion).toBe(version);
    // iOS Info.plist
    expect(plistString(iosInfoPlist, 'CFBundleShortVersionString')).toBe(version);
    expect(plistString(iosInfoPlist, 'CFBundleVersion')).toBe(version);
  });
});

describe('mobile app metadata: cihub deep-link scheme', () => {
  it('is declared on both iOS and Android', () => {
    // tauri.conf desktop scheme is the canonical name
    expect(tauriConf.plugins['deep-link'].desktop.schemes).toContain(EXPECTED_SCHEME);

    // iOS: CFBundleURLSchemes in both Info.plist and project.yml
    expect(iosInfoPlist).toMatch(new RegExp(`<key>CFBundleURLSchemes</key>\\s*<array>\\s*<string>${EXPECTED_SCHEME}</string>`));
    expect(iosProjectYml).toMatch(new RegExp(`CFBundleURLSchemes:\\s*\\[\\s*${EXPECTED_SCHEME}\\s*\\]`));

    // Android: <data android:scheme="cihub" />
    expect(androidManifest).toMatch(new RegExp(`android:scheme="${EXPECTED_SCHEME}"`));
  });

  it('registers the scheme in plugins.deep-link.mobile (else the plugin drops ALL deep links at runtime)', () => {
    // The Tauri deep-link plugin's Android isDeepLink() returns false when
    // `mobile` is empty, silently dropping every cihub:// link (OIDC callback,
    // pairing, App Intents) — cold-start AND while-running. So `mobile` must
    // register the cihub scheme, not just the desktop `schemes` list.
    const mobile = tauriConf.plugins['deep-link'].mobile;
    expect(Array.isArray(mobile)).toBe(true);
    expect(mobile.length).toBeGreaterThan(0);
    expect(mobile.some((d: { scheme?: string[] }) => d.scheme?.includes(EXPECTED_SCHEME))).toBe(true);
  });
});

describe('mobile app metadata: iOS deployment target', () => {
  it('is iOS 16 in both project.yml and tauri.conf', () => {
    expect(iosDeploymentTarget).toBe(EXPECTED_IOS_TARGET);
    expect(tauriConf.bundle.iOS.minimumSystemVersion).toBe(EXPECTED_IOS_TARGET);
  });
});
