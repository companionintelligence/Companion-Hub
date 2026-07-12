# Companion Hub — Mobile (iOS / Android)

A Tauri 2 **thin client** for the Companion Intelligence Hub. Unlike the desktop
app (`packages/desktop`), it does **not** run a Hub locally — phones can't run
Docker. Instead it embeds the same React frontend (`packages/frontend`) and
connects to a **remote Hub appliance** the user selects from the cloud device
picker (sign in to `hub.ci.computer` → pick a Hub → it loads the normal Hub UI).

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

> The `cihub://` URL scheme must be registered in the generated native projects
> (`gen/apple/.../Info.plist` `CFBundleURLTypes`, and the Android manifest
> `intent-filter`) for the Portal SSO callback to return to the app.

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
