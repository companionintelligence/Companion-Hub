# Companion Hub — Mobile (iOS / Android)

A Tauri 2 **thin client** for the Companion Intelligence Hub. **iOS and Android**
use the cloud connect flow (`/connect`: Portal sign-in → pick a remote Hub →
Hub `/login`). **Mac, Linux, and Windows** (browser or `packages/desktop`) set
up a Hub the normal way — they never see the picker. Phones can't run Docker,
so this app embeds the same React frontend (`packages/frontend`) and points it
at a remote appliance.

## How it works

```
Portal (hub.ci.computer)            Appliance Hub (hub-<dev>-<org>.ci.computer)
  POST /api/auth/sign-in/email  ─┐    GET /api/auth/portal/start?desktop=1
  GET  /api/devices  ───────────┘      → cihub://auth?token=…  (deep link)
        │  list of hubs + urls          GET /api/auth/portal/desktop-exchange?token=…
        ▼                                 → { sessionId }   ==> X-CI-Hub-Session
   [pick a hub] ─ set client baseUrl ─> load existing Hub SPA with that session
```

The native shell (`src-tauri`) only captures the `cihub://` deep links (Portal
SSO + pairing) and exposes the Tauri HTTP/store/os/notification/opener plugins.
All Hub auth (portal SSO, password, TOTP) is reused from the existing frontend.

## Prerequisites

- **Rust** + the mobile targets:
  `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- **Android:** JDK 17, Android SDK + NDK. Set `ANDROID_HOME`, `NDK_HOME`, `JAVA_HOME`.
- **iOS:** Xcode (full, not just Command Line Tools); `xcode-select` pointed at it.

## Commands

```bash
pnpm install                       # pulls @tauri-apps/cli
pnpm --filter frontend build       # produce dist/client (also done by turbo)

pnpm --filter mobile android:init  # generate gen/android (once)
pnpm --filter mobile android:dev   # run on an emulator/device

pnpm --filter mobile ios:init      # generate gen/apple (once, macOS + Xcode)
pnpm --filter mobile ios:dev       # run in the Simulator
```

Always pass the Simulator name so a plugged-in iPhone is not chosen, and do
**not** add an extra `--` (that drops the device argument):

```bash
VITE_HUB_RUNTIME=mobile pnpm --filter frontend run dev   # :5005
IPHONEOS_DEPLOYMENT_TARGET=16.0 \
  pnpm --filter mobile exec tauri ios dev "iPhone 17"
```

`devUrl` is `http://lvh.me:5005` (`lvh.me` → `127.0.0.1`). That hostname is
**not** treated as a local-network URL, so Tauri skips the `tauri://localhost`
mobile-dev proxy (a black WKWebView on iOS 26). Do not pass `--host 127.0.0.1`
— that puts the proxy back.

Compile and run on the Simulator against the **development** Portal
(`hub.companionintelligence.com`):

```bash
CI_CLOUD_URL=https://hub.companionintelligence.com \
CI_HUB_ENVIRONMENT=development \
VITE_HUB_RUNTIME=mobile \
  pnpm --filter frontend run dev

IPHONEOS_DEPLOYMENT_TARGET=16.0 \
  pnpm --filter mobile exec tauri ios dev "iPhone 17"
```

> The `cihub://` URL scheme must be registered in the generated native projects
> (`gen/apple/.../Info.plist` `CFBundleURLTypes`, and the Android manifest
> `intent-filter`) for the Portal SSO / OIDC callback to return to the app.
>
> **Simulator: "Open with Companion Hub" then a black screen.** iOS delivered
> `cihub://auth/callback` but the webview navigated onto that custom scheme
> (no HTML). Rebuild the mobile shell so Rust stashes the URL, emits
> `deep-link-oidc`, and navigates the webview back to `/connect`. A stale
> callback from a previous attempt can also re-open the app on `cihub://` —
> delete the app from the Simulator and relaunch `ios:dev` after rebuilding.

## Building in CI (GitHub Actions)

The mobile app builds in CI the same way the desktop app does — via
[`.github/workflows/mobile-build.yml`](../../.github/workflows/mobile-build.yml)
(the mobile counterpart to `desktop-build.yml`). It has two jobs:

| Job | Runner | Produces | Artifact |
|-----|--------|----------|----------|
| **android** | `ubuntu-22.04` | `tauri android build --apk --debug` → installable universal **debug APK** | `companion-hub-android-debug-apk` |
| **ios** | `macos-latest` | `tauri ios build --target aarch64-sim` → unsigned **iOS Simulator `.app`** | `companion-hub-ios-sim-app` |

**Triggers**
- **Manually:** GitHub → **Actions → Mobile Build → Run workflow** (`workflow_dispatch`).
- **Automatically:** on push to `dev` that touches `packages/mobile/**`,
  `packages/frontend/**`, `packages/common/**`, or the workflow file.

**Get the builds:** open the workflow run → **Summary** → download the artifact
zips. Then:
```bash
# Android — install on any device/emulator (the debug APK is debug-signed)
adb install -r app-universal-debug.apk

# iOS — drag "Companion Hub.app" onto a booted Simulator, or:
xcrun simctl install booted "Companion Hub.app"
```

No secrets are required for these artifacts. CI's macOS runner ships a **stable
Xcode**, so the local swift-rs × Xcode-27 workaround below is **not** needed there.

### Release signing (store-ready AAB / IPA)

> Shipping to the stores? Start with **[`STORE-READINESS.md`](./STORE-READINESS.md)** —
> the full submission checklist (what's done vs. what needs an account). Post-v1
> plans live in **[`ROADMAP.md`](./ROADMAP.md)**.

The default artifacts are for testing. A distributable build needs release
signing, which is intentionally left out of the default workflow (no secrets to
leak):

- **Android AAB** — add a Play upload keystore as repo secrets
  (`ANDROID_KEY_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`,
  `ANDROID_KEY_STORE_PASSWORD`). The `android-release` job in
  `mobile-build.yml` then decodes it, writes `gen/android/keystore.properties`
  (which `app/build.gradle.kts` picks up to wire `signingConfigs.release`), and
  runs `tauri android build --aab`. Without the secrets the job skips cleanly.
  Trigger it from **Actions → Mobile Build → Run workflow**.
- **iOS IPA** — add an Apple Developer signing cert + provisioning profile as
  secrets (e.g. via `apple-actions/import-codesign-certs`), set
  `bundle.iOS.developmentTeam` / `APPLE_DEVELOPMENT_TEAM`, and run
  `tauri ios build --export-method app-store-connect` (or `ad-hoc`) on a device
  target instead of `--target aarch64-sim`.

## Building iOS on Xcode 27

The app **builds, installs, and runs on the iOS 27 simulator** (verified
2026-07-11, Xcode 27.0 / 27A5209h) — but `swift-rs 1.0.7` (pinned by Tauri
2.11.3) predates Xcode 27, so three **local-only** toolchain workarounds are
needed. None are app code; keep them out of commits.

Vendor `swift-rs` (copy from
`~/.cargo/registry/src/*/swift-rs-1.0.7`), point at it with
`[patch.crates-io] swift-rs = { path = "…/vendored/swift-rs" }` in
`src-tauri/Cargo.toml`, and build with `IPHONEOS_DEPLOYMENT_TARGET=16.0`
(App Intents' minimum). In the vendored `src-rs/build.rs`:

1. **SDK selection.** Replace `.args(["--arch", arch])` with
   `.args(["--triple", &swift_target_triple])` (else SwiftPM picks the macOS SDK →
   `unable to resolve module 'UIKit'`), and resolve the link-search path by a
   recursive lookup of `lib<pkg>.a` (Xcode 27 writes to
   `out/Products/<Config>-iphonesimulator/`, canonicalize the `release` symlink).
2. **`@_cdecl` internalization.** Swift 6.4's *release*-mode whole-module
   optimization marks `swift-rs`'s C entry points as **local** (`t _log_stdout`,
   not `T`), so they can't be linked. Build the Swift packages `-c debug` instead
   (`.args(["-c", "debug"])`) — they keep external linkage. (The app ran on Xcode
   27 *beta* without this; the 27.0/Swift-6.4 release regressed it.)

And in the **app crate's** `src-tauri/build.rs` (final crate):

3. **Link propagation.** `swift-rs`'s `cargo:rustc-link-lib=static` (emitted from
   tauri's transitive build script) doesn't reach the final
   `aarch64-apple-ios-sim` link under Xcode 27. Re-emit
   `cargo:rustc-link-search=native=…` + `cargo:rustc-link-lib=static=<pkg>` for
   each `swift-rs/*/…-iphonesimulator/lib*.a` from the final crate's `build.rs`
   (its directives *do* reach the link).

With all three, `pnpm tauri ios build --target aarch64-sim` succeeds; install the
`.app` from `~/Library/Developer/Xcode/DerivedData/ci-os-hub-mobile-*/Build/
Products/release-iphonesimulator/` with `xcrun simctl install`. (`tauri`'s own
archive-rename step then errors harmlessly — the built `.app` is already there.)

Note: `simctl io screenshot` returns black for the WKWebView layer on the
simulator — the app *is* rendering (check the unified log for a WebKit
`Created rendering backend`), or inspect via Safari ▸ Develop.
