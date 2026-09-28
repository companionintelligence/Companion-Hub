import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Store-submission regression guards for the CI-Hub mobile app.
 *
 * Each assertion here corresponds to a real App Store / Play blocker found in
 * the 2026-07 delivery review. They're cheap config invariants that are easy to
 * silently undo — `tauri icon` regeneration reintroducing an alpha channel, an
 * xcodegen run dropping the privacy manifest, a "cleanup" deleting an ATS key —
 * and each one costs a rejected upload or a review round-trip to rediscover.
 *
 * See packages/mobile/STORE-READINESS.md for the full checklist.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ -> frontend -> packages -> packages/mobile/src-tauri
const TAURI = path.resolve(here, '../../mobile/src-tauri');

const read = (rel: string): string => readFileSync(path.join(TAURI, rel), 'utf8');
const exists = (rel: string): boolean => existsSync(path.join(TAURI, rel));

/** True when a PNG declares an alpha channel (color type 4/6) or palette transparency (tRNS). */
function pngHasAlpha(rel: string): boolean {
  const buf = readFileSync(path.join(TAURI, rel));
  // PNG: 8-byte signature, then IHDR (4 len + 4 type + 13 data);
  // data = width(4) height(4) bitDepth(1) colorType(1) ...
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG'); // sanity: really a PNG
  const colorType = buf[25];
  const hasAlphaChannel = colorType === 4 || colorType === 6;
  const hasPaletteTransparency = buf.includes(Buffer.from('tRNS', 'ascii'));
  return hasAlphaChannel || hasPaletteTransparency;
}

// ── iOS ─────────────────────────────────────────────────────────────────────

describe('iOS store readiness', () => {
  it('ships a privacy manifest registered as a bundle resource', () => {
    // Apple has rejected uploads without required-reason declarations since May 2024.
    expect(exists('gen/apple/PrivacyInfo.xcprivacy')).toBe(true);
    const manifest = read('gen/apple/PrivacyInfo.xcprivacy');

    // No tracking — keeps us out of ATT and the "tracking" privacy label.
    expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);

    // Required-reason APIs the Tauri runtime actually touches.
    for (const [api, reason] of [
      ['NSPrivacyAccessedAPICategoryFileTimestamp', 'C617.1'],
      ['NSPrivacyAccessedAPICategorySystemBootTime', '35F9.1'],
      ['NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1'],
    ]) {
      expect(manifest).toContain(api);
      expect(manifest).toContain(reason);
    }

    // Declared collection matches what the connect flow actually sends to the Portal.
    expect(manifest).toContain('NSPrivacyCollectedDataTypeEmailAddress');
    expect(manifest).toContain('NSPrivacyCollectedDataTypeCredentials');

    // It must be a target resource or xcodegen leaves it out of the bundle,
    // which fails validation exactly as if it never existed.
    expect(read('gen/apple/project.yml')).toMatch(/path:\s*PrivacyInfo\.xcprivacy/);
  });

  it('pre-answers export compliance (standard TLS only)', () => {
    expect(read('gen/apple/project.yml')).toMatch(/ITSAppUsesNonExemptEncryption:\s*false/);
    expect(read('gen/apple/ci-os-hub-mobile_iOS/Info.plist')).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  });

  it('declares a local-network purpose string to match the LAN Hub capability', () => {
    // capabilities/default.json allows http://192.168.*/10.* through the native
    // HTTP client — that trips iOS's local-network gate, which requires a
    // purpose string. If the LAN URLs ever go away, this can too.
    const caps = read('capabilities/default.json');
    const allowsLan = /192\.168|10\.\*/.test(caps);
    if (allowsLan) {
      expect(read('gen/apple/ci-os-hub-mobile_iOS/Info.plist')).toMatch(/<key>NSLocalNetworkUsageDescription<\/key>/);
    }
  });

  it('keeps the ATS local-networking exception that LAN Hubs depend on', () => {
    // Narrow local-only carve-out (NOT NSAllowsArbitraryLoads) — needed in
    // release for LAN Hubs, not just dev. Guards against a well-meaning cleanup.
    const plist = read('gen/apple/ci-os-hub-mobile_iOS/Info.plist');
    expect(plist).toMatch(/<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
    expect(plist).not.toContain('NSAllowsArbitraryLoads');
  });

  it('has an opaque 1024 marketing icon (alpha fails App Store upload validation)', () => {
    // Both the asset-catalog copy AND the `tauri icon` source, or a future
    // regeneration silently reintroduces the alpha channel.
    expect(pngHasAlpha('gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')).toBe(false);
    expect(pngHasAlpha('icons/ios/AppIcon-512@2x.png')).toBe(false);
  });

  it('declares associated-domains for Universal Links', () => {
    const entitlements = read('gen/apple/ci-os-hub-mobile_iOS/ci-os-hub-mobile_iOS.entitlements');
    expect(entitlements).toContain('com.apple.developer.associated-domains');
    expect(entitlements).toContain('<string>applinks:hub.ci.computer</string>');
    expect(entitlements).toContain('<string>applinks:hub.companionintelligence.com</string>');
  });
});

// ── Android ─────────────────────────────────────────────────────────────────

describe('Android store readiness', () => {
  const manifest = read('gen/android/app/src/main/AndroidManifest.xml');
  const gradle = read('gen/android/app/build.gradle.kts');

  it('disables auto-backup so the Hub session token is not uploaded to Google', () => {
    // The WebView localStorage holds the X-CI-Hub-Session bearer id and the
    // Tauri stores hold the chosen Hub URL; allowBackup defaults to TRUE.
    expect(manifest).toMatch(/android:allowBackup="false"/);
  });

  it('resizes for the soft keyboard', () => {
    expect(manifest).toMatch(/android:windowSoftInputMode="adjustResize"/);
  });

  it('ships an adaptive launcher icon (Android 8+ masks legacy PNGs)', () => {
    expect(exists('gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml')).toBe(true);
    const adaptive = read('gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml');
    expect(adaptive).toContain('<adaptive-icon');
    expect(adaptive).toMatch(/android:drawable="@mipmap\/ic_launcher_foreground"/);
    expect(adaptive).toMatch(/android:drawable="@color\/ic_launcher_background"/);
    // The referenced background color resource must exist, or the build fails.
    expect(exists('gen/android/app/src/main/res/values/ic_launcher_background.xml')).toBe(true);
    expect(read('gen/android/app/src/main/res/values/ic_launcher_background.xml')).toMatch(/name="ic_launcher_background"/);
  });

  it('wires release signing from keystore.properties without breaking keyless dev builds', () => {
    expect(gradle).toContain('keystore.properties');
    expect(gradle).toMatch(/signingConfigs\s*\{/);
    // Guarded so debug/dev builds still work with no keystore present.
    expect(gradle).toContain('hasReleaseKeystore');
    expect(gradle).toMatch(/signingConfig\s*=\s*signingConfigs\.getByName\("release"\)/);
  });

  it('keeps release builds minified and cleartext-free', () => {
    expect(gradle).toMatch(/isMinifyEnabled\s*=\s*true/);
    expect(gradle).toMatch(/manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"false"/);
  });

  it('targets an API level Play still accepts for new uploads', () => {
    const target = Number(gradle.match(/targetSdk\s*=\s*(\d+)/)?.[1]);
    expect(target).toBeGreaterThanOrEqual(35);
  });

  it('declares autoVerify intent-filter for Android App Links', () => {
    expect(manifest).toMatch(/<intent-filter\s+android:autoVerify="true">/);
    expect(manifest).toMatch(/android:scheme="https"\s+android:host="hub\.ci\.computer"\s+android:pathPrefix="\/auth"/);
    expect(manifest).toMatch(/android:scheme="https"\s+android:host="hub\.companionintelligence\.com"\s+android:pathPrefix="\/auth"/);
  });
});

// ── Cross-platform posture ──────────────────────────────────────────────────

describe('mobile privacy/permission posture', () => {
  it('requests no notification permission until notifications are a real feature', () => {
    // The plugin was registered with zero frontend callers, dragging
    // POST_NOTIFICATIONS / RECEIVE_BOOT_COMPLETED / WAKE_LOCK into the merged
    // Android manifest — permission surface a store reviewer may question.
    // Re-add deliberately alongside the push epic (see ROADMAP.md).
    expect(read('capabilities/default.json')).not.toContain('notification:');
    expect(read('src/lib.rs')).not.toContain('tauri_plugin_notification');
  });

  it('does not let the webview load images over plaintext http', () => {
    const csp = (JSON.parse(read('tauri.conf.json')) as { app: { security: { csp: string } } }).app.security.csp;
    const imgSrc = csp.match(/img-src([^;]*)/)?.[1] ?? '';
    expect(imgSrc).not.toMatch(/\bhttp:/);
    expect(imgSrc).toMatch(/\bhttps:/);
  });

  it('scopes the native HTTP allowlist to CI domains + localhost/LAN (never a wildcard)', () => {
    const caps = JSON.parse(read('capabilities/default.json')) as {
      permissions: Array<string | { identifier: string; allow?: Array<{ url: string }> }>;
    };
    const http = caps.permissions.find(
      (p): p is { identifier: string; allow?: Array<{ url: string }> } => typeof p === 'object' && p.identifier === 'http:default',
    );
    expect(http?.allow?.length).toBeGreaterThan(0);
    for (const { url } of http?.allow ?? []) {
      expect(url).not.toBe('https://**');
      expect(url).not.toMatch(/^https?:\/\/\*\/?\*?$/); // bare wildcard host
    }
    // The Portal must stay reachable or sign-in breaks.
    expect(http?.allow?.some((a) => a.url.includes('hub.ci.computer'))).toBe(true);
  });

  /*
   * Every zone Companion Portal publishes a Hub under, the new `.pw` zones first.
   * The app reaches a Hub at its public hostname through the native HTTP client
   * (`http:default`), and its events and sockets through the webview (CSP
   * `connect-src`, `remote.urls`). A zone missing from any one of the three is a
   * Hub the phone cannot sign in to, with nothing on screen saying why.
   */
  const HUB_ZONES = [
    'ci.computer',
    'companionintelligence.com',
    'companionintel.com',
    'ci0.pw',
    'ci1.pw',
    'ci2.pw',
    'ci3.pw',
    'ci4.pw',
    'ci5.pw',
    'ci6.pw',
    'ci8.pw',
    'ci9.pw',
    'chimera.engineer',
    'chimeracompute.com',
    'chimeracomputer.com',
    'companionintelligence.io',
    'companionintelligence.org',
    'lifescope.io',
    'mysticalengine.com',
  ];

  it.each(HUB_ZONES)('can reach a Hub published under %s', (zone) => {
    const caps = JSON.parse(read('capabilities/default.json')) as {
      remote: { urls: string[] };
      permissions: Array<string | { identifier: string; allow?: Array<{ url: string }> }>;
    };
    const http = caps.permissions.find(
      (p): p is { identifier: string; allow?: Array<{ url: string }> } => typeof p === 'object' && p.identifier === 'http:default',
    );
    const csp = (JSON.parse(read('tauri.conf.json')) as { app: { security: { csp: string } } }).app.security.csp;
    const connectSrc = (csp.match(/connect-src([^;]*)/)?.[1] ?? '').trim().split(/\s+/);

    expect(http?.allow?.map((entry) => entry.url)).toContain(`https://*.${zone}/*`);
    expect(caps.remote.urls).toContain(`https://*.${zone}`);
    expect(connectSrc).toContain(`https://*.${zone}`);
    expect(connectSrc).toContain(`wss://*.${zone}`);
  });

  it('keeps the generated capability schema in step with the capability file', () => {
    const caps = JSON.parse(read('capabilities/default.json')) as { remote: unknown; permissions: unknown };
    const generated = JSON.parse(read('gen/schemas/capabilities.json')) as {
      default: { remote: unknown; permissions: unknown };
    };

    expect(generated.default.remote).toEqual(caps.remote);
    expect(generated.default.permissions).toEqual(caps.permissions);
  });
});
