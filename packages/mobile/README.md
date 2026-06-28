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
