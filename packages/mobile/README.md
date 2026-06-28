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

## Building iOS on Xcode 27 beta

`swift-rs 1.0.7` (pinned by Tauri 2.11.3) cannot cross-compile Tauri's Swift
mobile lib under Xcode 27 beta: it relies on `swift build`'s `-Xswiftc -sdk`
override coming last, but Xcode 27's SwiftPM reorders flags so the macOS SDK
wins (`unable to resolve module 'UIKit'`). Until Tauri/swift-rs ship Xcode-27
support (or you build with a stable Xcode 16.x), apply this local patch:

1. Vendor `swift-rs` (copy from `~/.cargo/registry/src/*/swift-rs-1.0.7`) and in
   its `src-rs/build.rs`, in the `swift build` command, replace
   `.args(["--arch", arch])` with `.args(["--triple", &swift_target_triple])`,
   and replace the hardcoded `{arch}-apple-macosx/{config}` link-search path with
   a recursive lookup of `lib<package>.a` under the build dir.
2. `[patch.crates-io] swift-rs = { path = "…/vendored/swift-rs" }` in
   `src-tauri/Cargo.toml`.
3. Build with `IPHONEOS_DEPLOYMENT_TARGET=15.0` set (Tauri reads it; default 13.0
   is below Xcode 27's minimum).

With that patch the app builds, installs and runs on the iOS 27 simulator. Note:
`simctl io screenshot` returns black for the WKWebView layer on the simulator —
inspect via Safari ▸ Develop instead.
