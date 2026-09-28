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

The native shell (`src-tauri`) captures the `cihub://` deep links (Portal
SSO + pairing), presents Portal sign-in on iOS in an in-app Safari sheet
(`ASWebAuthenticationSession` via `start_auth_session`), and exposes the Tauri
HTTP/store/os/deep-link/opener plugins.
(`tauri-plugin-notification` was deliberately **removed** — it dragged
POST_NOTIFICATIONS/RECEIVE_BOOT_COMPLETED/WAKE_LOCK into the Android manifest
with zero callers. Re-add it alongside the push epic, see ROADMAP.md.)
All Hub auth (portal SSO, password, TOTP) is reused from the existing frontend.

## First-time setup

Work through this once on a new machine. Each step ends with a command that
proves it worked — the failures below are all ones a clean Mac actually hits,
and most of them fail *late* (deep in a 10-minute Rust build) if you skip ahead.

### 1. Rust + mobile targets

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios \
  aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
rustup target list --installed | grep -cE 'ios|android'    # expect 7
```

### 2. Android — SDK, NDK, and a JDK

`JAVA_HOME` is the one people miss: macOS ships **no** JDK, so `java -version`
fails with *"Unable to locate a Java Runtime"* and Gradle dies with a message
that never mentions Java. Android Studio bundles one you can point at.

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | sort -V | tail -1)"
export JAVA_HOME=/opt/homebrew/opt/openjdk@17          # or:
# export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"

java -version                                    # must print a version
ls "$ANDROID_HOME/platforms" "$NDK_HOME" >/dev/null && echo "sdk+ndk ok"
```

Put those exports in your shell profile — a login shell without them is the
single most common cause of a failed Android build.

### 3. iOS — Xcode with an iOS SDK

A *full* Xcode, not just Command Line Tools. Check that the selected Xcode
actually has an iOS SDK — having Xcode installed is not the same thing:

```bash
xcode-select -p
xcodebuild -showsdks | grep -i iphone      # must list an iOS + iOS Simulator SDK
```

If this prints nothing, that Xcode has no iOS platform installed. On a machine
with several Xcodes, only one may be usable — select it with
`sudo xcode-select -s /Applications/<Xcode>.app` (needs your password), or
override per-command with `DEVELOPER_DIR=/Applications/<Xcode>.app/Contents/Developer`,
which needs no sudo.

> Xcode **27** additionally needs the vendored-`swift-rs` workaround in
> [Building iOS on Xcode 27](#building-ios-on-xcode-27). Nothing builds for the
> simulator without it.

### 4. Optional — driving the simulator from an agent

Two MCP servers cover build + UI automation and are the most reliable path
today:

```bash
claude mcp add xcodebuild    -- npx -y xcodebuildmcp@latest mcp
claude mcp add ios-simulator -- npx -y ios-simulator-mcp@latest
npx -y -p xcodebuildmcp@latest xcodebuildmcp-doctor     # verify
```

Note `xcodebuildmcp` needs the **`mcp` subcommand** — without it the process
prints usage and exits, and the server silently never starts.

The `ui_*` tools (tap/type/describe) additionally need `idb_companion`:

```bash
brew trust facebook/fb && brew install idb-companion
```

which itself wants the *Command Line Tools for Xcode* matching your Xcode,
a manual download from
[developer.apple.com/download/all](https://developer.apple.com/download/all/).
Screenshot, install and launch work without it.

## Commands

```bash
pnpm install                       # pulls @tauri-apps/cli
pnpm --filter frontend build       # produce dist/client (also done by turbo)

# ⚠️ The gen/ project sources are COMMITTED. `*:init` regenerates them and will
# clobber the checked-in Xcode/Gradle config (privacy manifest wiring, scene
# manifest, ATS keys, signingConfig). You do NOT need it on a normal checkout —
# only when intentionally re-scaffolding, and then review the diff.
pnpm --filter mobile android:init  # RE-generate gen/android (clobbers committed config)
pnpm --filter mobile android:dev   # run on an emulator/device

pnpm --filter mobile ios:init      # RE-generate gen/apple (same caveat)
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

Cloud connect defaults to the **production** Portal (`hub.ci.computer`), even when
this checkout's `.env.dev` points the Hub appliance at the internal cloud. A custom
Companion URL can be set under **Advanced** on `/connect`.

```bash
VITE_HUB_RUNTIME=mobile pnpm --filter frontend run dev

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
(the mobile counterpart to `desktop-build.yml`). It has **four** jobs — two that
always run, and two release lanes that skip cleanly until their signing secrets
exist:

| Job | Runner | Produces | Artifact |
|-----|--------|----------|----------|
| **android** | `ubuntu-22.04` | `tauri android build --apk --debug` → installable universal **debug APK** | `companion-hub-android-debug-apk` |
| **ios** | `macos-latest` | `tauri ios build --target aarch64-sim` → unsigned **iOS Simulator `.app`** | `companion-hub-ios-sim-app` |
| **android-release** | `ubuntu-22.04` | signed **AAB** for Play — needs the 4 `ANDROID_KEY_*` secrets | `companion-hub-android-release-aab` |
| **ios-release** | `macos-latest` | signed **IPA** for App Store Connect — needs the 4 `APPLE_*` secrets | `companion-hub-ios-release-ipa` |

**Triggers**
- **Manually:** GitHub → **Actions → Mobile Build → Run workflow** (`workflow_dispatch`).
- **Automatically:** on push to `dev` touching `packages/mobile/**`,
  `packages/frontend/**`, `packages/common/**`, or the workflow file itself.

  These triggers were disabled for six weeks — removed in passing by `91a67de58`,
  a Docker-engine change, under a "TEMPORARY (Actions credit)" note — and restored
  once a dispatched run proved `dev` still builds green on all four jobs.
  `packages/frontend` is in the path list because the mobile shell loads that same
  React app: a frontend-only change can break mobile without touching
  `packages/mobile` at all.

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
- **iOS IPA** — the `ios-release` job already does all of this; you only supply
  secrets. It imports the cert into a throwaway keychain (`security import`, not
  `apple-actions/import-codesign-certs`), installs the provisioning profile,
  stamps a monotonic `CFBundleVersion`, and builds with
  `--export-method app-store-connect`. Set `APPLE_CERTIFICATE_BASE64`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_PROVISIONING_PROFILE_BASE64` and
  `APPLE_DEVELOPMENT_TEAM`; add the three `APPSTORE_API_*` secrets to also push
  to TestFlight. Without them the job skips cleanly. See
  [`STORE-READINESS.md`](./STORE-READINESS.md).

  > ⚠️ **Unproven.** The lane has never completed a signed build — every
  > `workflow_dispatch` run so far skipped it for missing secrets, so its first
  > real run should be treated as a debugging session, not a release.

## Building iOS on Xcode 27

The app **builds, installs, and runs on the iOS 27 simulator** (verified
2026-07-11, Xcode 27.0 / 27A5209h) — but `swift-rs 1.0.7` (pinned by Tauri
2.11.3) predates Xcode 27, so three **local-only** toolchain workarounds are
needed. None are app code; keep them out of commits.

Vendor `swift-rs` (copy from `~/.cargo/registry/src/*/swift-rs-1.0.7`), point at
it from `src-tauri/Cargo.toml`, and build with `IPHONEOS_DEPLOYMENT_TARGET=16.0`
(App Intents' minimum).

> **Two traps when wiring up the patch — both cost a full failed build:**
>
> 1. `src-tauri/Cargo.toml` **already has a `[patch.crates-io]` section** (for
>    `glib`). Appending a second one is a no-op or a duplicate-section error —
>    add the line *inside* the existing section:
>
>    ```toml
>    [patch.crates-io]
>    swift-rs = { path = "../vendored/swift-rs" }
>    glib = { path = "../../../third_party/glib-0.18.5" }
>    ```
>
> 2. Cargo keeps the **already-compiled registry copy** until you tell it
>    otherwise, so the patch appears to do nothing. Force the swap and confirm
>    it took — you want to see `Removing swift-rs v1.0.7`:
>
>    ```bash
>    cargo update -p swift-rs --manifest-path src-tauri/Cargo.toml
>    ```

In the vendored `src-rs/build.rs`:

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

### Telling "rendering" apart from "blank"

`simctl io screenshot` returns black for the WKWebView layer on the simulator,
so **a black screenshot proves nothing either way** — do not read it as "the app
is fine". Two checks that actually distinguish the cases:

```bash
UDID=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)

# 1. Did React actually mount? i18next only writes this key after it does.
C=$(xcrun simctl get_app_container "$UDID" computer.ci.app.hub data)
sqlite3 "$(find "$C/Library/WebKit" -name localstorage.sqlite3 | head -1)" \
  'SELECT key FROM ItemTable;'          # expect i18nextLng

# 2. Did the main frame load, or did something cancel/replace it?
xcrun simctl spawn "$UDID" log show --last 2m --style compact \
  --predicate 'process == "Companion Hub"' \
  | grep -E 'didFinishLoading|didFailProvisionalLoadForFrame'
```

A healthy boot shows ~100+ `didFinishLoading` **and** an `i18nextLng` key. Many
finished resource loads with *no* `i18nextLng` means assets are being served but
the app never mounted — that is a blank screen, not a capture artifact.
`didFailProvisionalLoadForFrame … isMainFrame=1, code=-999` is
`NSURLErrorCancelled`: a navigation superseded the one in flight.

`snapshot_ui` from XcodeBuildMCP is the quickest signal of all — it returns
`targets: []` for a genuinely empty screen. Safari ▸ Develop still works for a
live DOM.

---

## Troubleshooting

Symptoms seen on real machines, with the actual cause. Most of these fail late
and blame the wrong thing.

| Symptom | Cause | Fix |
|---|---|---|
| `Unable to locate a Java Runtime`, or Gradle fails with no mention of Java | macOS ships no JDK | Set `JAVA_HOME` ([step 2](#2-android--sdk-ndk-and-a-jdk)) |
| `unable to resolve module 'UIKit'`, `could not build module 'WebKit'`, or references to `MacOSX*.sdk` in an **iOS** build | SwiftPM picked the macOS SDK — the Xcode 27 `swift-rs` bug | [Xcode 27 workaround](#building-ios-on-xcode-27) |
| The `swift-rs` patch "does nothing" | Second `[patch.crates-io]` section, or Cargo reused the cached registry build | Both traps in [Xcode 27](#building-ios-on-xcode-27) |
| `xcodebuild -showsdks` lists no iPhone SDK | That Xcode has no iOS platform | Select another Xcode, or `DEVELOPER_DIR=…` |
| `failed to rename app … Directory not empty (os error 66)` at the very end of `tauri ios build` | Tauri's post-build archive-rename step | **Harmless** — the `.app` is already built. Check for real errors instead of trusting the exit code |
| A build "succeeds" but nothing changed | You piped the build through `\| tail`, which masks the exit code | Capture the real status: `cmd > log 2>&1; echo $?` |
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` installing an Android **release** APK | `tauri android build --apk` emits `app-universal-release-unsigned.apk` | Sign it with the debug key (below) |
| MCP server `xcodebuild` never starts | Missing the `mcp` subcommand | `npx -y xcodebuildmcp@latest mcp` |
| Black simulator screenshot | Says nothing on its own | [Telling "rendering" apart from "blank"](#telling-rendering-apart-from-blank) |

### Installing an unsigned release APK locally

`--apk` produces an *unsigned* release APK, which Android refuses to install.
For local testing, sign it with the standard debug key:

```bash
BT=$(ls -d "$ANDROID_HOME/build-tools"/* | sort -V | tail -1)
cp src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk /tmp/hub.apk
"$BT/apksigner" sign --ks ~/.android/debug.keystore \
  --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey /tmp/hub.apk
"$BT/apksigner" verify /tmp/hub.apk && adb install -r /tmp/hub.apk
```

`apksigner` is a Java tool — it fails with a bare *"Please visit
http://www.java.com"* if `JAVA_HOME` is not exported in that shell.

### Generated Apple files are committed, and xcodegen does not regenerate them

`gen/apple/` is checked in, and **`Info.plist` is not regenerated from
`project.yml` during `tauri ios build`** — the committed plist is what ships.
Editing only `project.yml` changes nothing about the build. Change both, or edit
the plist directly:

```bash
plutil -replace CFBundleVersion -string 42 \
  src-tauri/gen/apple/ci-os-hub-mobile_iOS/Info.plist
```

This matters for release automation: any step that stamps a version into
`project.yml` alone is a no-op. See
[`STORE-READINESS.md`](./STORE-READINESS.md).
