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

`swift-rs 1.0.7` (pinned by Tauri 2.11.3) predates Xcode 27 and cannot
cross-compile Tauri's Swift mobile lib under it. Two separate problems:

**1. SDK selection (fixable with a local patch).** `swift-rs`'s build script runs
`swift build --arch <arch>`, which makes Xcode 27's SwiftPM emit *macOS*
`-sdk`/`-target` flags that win over swift-rs's `-Xswiftc` iOS overrides → the
Swift package compiles against the macOS SDK (`unable to resolve module 'UIKit'`,
`OpenGLES/EAGL.h` not found). Local workaround:

1. Vendor `swift-rs` (copy from `~/.cargo/registry/src/*/swift-rs-1.0.7`) and in
   its `src-rs/build.rs`, in the `swift build` command, replace
   `.args(["--arch", arch])` with `.args(["--triple", &swift_target_triple])`,
   and replace the hardcoded `{arch}-apple-macosx/{config}` link-search path with
   a recursive lookup of `lib<package>.a` under the build dir (Xcode 27 writes to
   `out/Products/<Config>-iphonesimulator/`).
2. `[patch.crates-io] swift-rs = { path = "…/vendored/swift-rs" }` in
   `src-tauri/Cargo.toml`.
3. Build with `IPHONEOS_DEPLOYMENT_TARGET=16.0` (App Intents' minimum; Tauri reads
   it, and the default is below Xcode 27's minimum).

With patch (1) the Swift packages compile and Xcode recognizes the App Intents.

**2. Static-lib link propagation (open, verified 2026-06-29 on Xcode 27.0).** Even
after (1), `swift-rs`'s `cargo:rustc-link-search` reaches the final
`aarch64-apple-ios-sim` link but its `cargo:rustc-link-lib=static=<pkg>` does
**not** — `-lTauri`/`-ltauri_plugin_*` are never passed, so the `.dylib` link
fails with undefined Swift symbols (`_log_stdout`, `_register_plugin`,
`_retain_object`, …). This is a `swift-rs`/toolchain issue independent of the app
code and needs an upstream `swift-rs` release with Xcode-27 support (or a heavier
in-repo workaround). The app built and ran on Xcode 27 *beta* with just patch (1);
the 27.0 release regressed this link step.

Note: `simctl io screenshot` returns black for the WKWebView layer on the
simulator — inspect via Safari ▸ Develop instead.
