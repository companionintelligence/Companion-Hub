# App Intents (iOS)

Companion Hub exposes its core actions to **Siri, the Shortcuts app, Spotlight,
and the Action Button** via Apple's [App Intents](https://developer.apple.com/documentation/appintents)
framework.

The app is a Tauri webview, so the intents don't reimplement navigation in
Swift. Each intent opens a `cihub://intent/<action>` deep link; the Rust shell
captures it and the React frontend routes it — the exact same pipeline that
already powers Portal SSO (`cihub://auth`) and pairing (`cihub://pair`). No new
IPC surface.

```
Siri / Shortcuts / Spotlight / Action Button
        │  runs an AppIntent
        ▼
Swift AppIntent.perform()  ──►  UIApplication.open("cihub://intent/<action>")
        │  (custom scheme round-trips through iOS back into the app)
        ▼
tauri-plugin-deep-link  ──►  Rust handle_deep_link_url() (src/lib.rs)
        │  extract_intent() → emits `deep-link-intent` + stashes (cold start)
        ▼
useAppIntentDeepLinks() (frontend)  ──►  resolveIntentNavigation()  ──►  navigate()
```

## Intents

| Intent | Action URL | Example phrases |
|--------|------------|-----------------|
| Open Companion Hub | `cihub://intent/home` | "Open Companion Hub", "Open my Hub in Companion Hub" |
| Connect a Hub | `cihub://intent/connect` | "Connect a Hub in Companion Hub" |
| Switch Hub | `cihub://intent/switch` | "Switch Hub in Companion Hub" |
| Open Hub Settings | `cihub://intent/settings` | "Open Companion Hub settings" |
| Open a Specific Hub | `cihub://intent/open?hub=<name>` | "Open _Apple Hub_ in Companion Hub" |

"Open a Specific Hub" takes the Hub name as a parameter. The name is matched
**in the frontend** (`src/lib/app-intents.ts → matchHubByName`) against the
user's known Hubs, which the picker persists whenever it loads the device list.
A known, reachable Hub is re-pointed-to and loaded; an unknown name falls back
to the connect screen.

## Files

- **Swift** — `src-tauri/gen/apple/Sources/AppIntents/CompanionHubAppIntents.swift`
  The `AppIntent` structs, the `CompanionHubShortcuts` `AppShortcutsProvider`
  (Siri phrases), and the `cihub://` deep-link bridge.
- **Rust** — `src-tauri/src/lib.rs`
  `extract_intent()`, `queue_intent()` (emits `deep-link-intent`), and the
  `consume_pending_intent` command for cold starts. Unit-tested.
- **Frontend** — `packages/frontend/src/lib/app-intents.ts` (parse/match/resolve/
  persist), `src/hooks/use-app-intent-deep-links.ts` (always-on router, mounted in
  `HubStatus`), and the `publishHubsToIntents` call in the connect page.

## Requirements

- **iOS 16+** — App Intents' minimum. The app's deployment target was raised
  from 15.0 → 16.0 (`project.yml` + `tauri.conf.json`); `import AppIntents`
  autolinks the framework cleanly at that target. The Swift is additionally
  `@available(iOS 16.0, *)`-guarded.
- App Intents and the `AppShortcutsProvider` are **auto-discovered** from the
  compiled binary — no `Info.plist` registration needed.

## Building / testing

The intents compile into the app target automatically (`project.yml` includes
`Sources/`; the committed `.xcodeproj` was regenerated with `xcodegen` and
Tauri regenerates it again at build time).

```bash
pnpm --filter mobile ios:build      # or: pnpm tauri ios build
```

Then, on an iOS 16+ device/simulator:

- **Shortcuts app** → the five actions appear under "Companion Hub".
- **Siri** → say one of the phrases above.
- **Spotlight** → search the shortcut titles.
- **Action Button** (iPhone 15 Pro+) → assign "Open Companion Hub".

Verify the round-trip: running an intent should open the app and land on the
right screen; "Open _<Hub>_" should connect to that Hub.

### Build status on Xcode 27.0 (verified 2026-06-29)

The App Intents implementation is **confirmed to compile** under Xcode 27.0
(release, build 27A5209h) targeting the iOS 26/27 simulator SDK:

- `CompanionHubAppIntents.swift` (all five intents + the `AppShortcutsProvider`)
  compiles cleanly.
- Xcode recognizes the App Shortcuts — the build sets
  `APP_SHORTCUTS_ENABLE_FLEXIBLE_MATCHING=YES`.
- The Rust shell, frontend, and intent capture compile for `aarch64-apple-ios-sim`.

**One toolchain blocker remains, unrelated to this feature.** Tauri's mobile
Swift glue is built by [`swift-rs`](https://crates.io/crates/swift-rs) `1.0.7`,
which predates Xcode 27. Two problems surface, both in `swift-rs`, not in our code:

1. **SDK selection (fixable).** `swift-rs`'s build script runs
   `swift build --arch <arch>`, which makes SwiftPM emit *macOS* `-sdk`/`-target`
   flags → the Swift package compiles against the macOS SDK → `OpenGLES/EAGL.h`,
   `UIKit/NSAttributedString.h` not found. Replacing `--arch` with
   `--triple <ios-triple>` (plus resolving the `swift build` output dir, which
   changed to `out/Products/<Config>-iphonesimulator/`) fixes this and the Swift
   packages compile.
2. **Static-lib link propagation (open).** Even with (1), `swift-rs`'s
   `cargo:rustc-link-search` reaches the final `aarch64-apple-ios-sim` link but
   its `cargo:rustc-link-lib=static=<pkg>` does **not** — so `-lTauri`,
   `-ltauri_plugin_*` are never passed and the link fails with undefined Swift
   symbols (`_log_stdout`, `_register_plugin`, `_retain_object`, …). This needs an
   upstream `swift-rs` release with Xcode-27 support (or a heavier in-repo
   workaround) and is tracked separately from App Intents.

The `--triple` fix is a local toolchain patch (not committed — it's a vendored
`swift-rs` change, not app code). Once `swift-rs` ships Xcode-27 support, this app
— App Intents included — builds and installs on the simulator with no code
changes. The App Intents Swift/Rust/JS layers are complete and the JS/Rust
layers are unit-tested.

## Possible follow-ups

- **Dynamic Hub suggestions in the Shortcuts editor.** Today "Open a Specific
  Hub" takes a free-form `String`. A full `AppEntity` + `EntityQuery` would let
  the editor auto-suggest the user's Hubs, but the query runs out-of-process and
  would need an **App Group** shared store populated from the app. Deferred.
- **Android parity** via App Shortcuts (`shortcuts.xml`) / Google Assistant App
  Actions — the Android analog of this iOS-only feature.
