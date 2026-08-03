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
- **`plugins.deep-link.mobile` must register the `cihub` scheme** in
  `tauri.conf.json` (`"mobile": [{ "scheme": ["cihub"] }]`). The Tauri deep-link
  plugin's `isDeepLink()` returns `false` when `mobile` is empty and drops every
  `cihub://` link on mobile — so with `mobile: []` the intents never reach the
  app. The Rust shell also registers `deep_link().on_open_url()` for
  while-running delivery (the `deep-link://new-url` event is desktop-only).
  Verified on the Android emulator: `cihub://intent/settings` →
  `consume_pending_intent` returns `"settings"`.

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

### Build status — verified running on the iOS 27 simulator (2026-07-11)

The App Intents implementation **builds, installs, launches, and registers on
the iPhone 17 (iOS 27) simulator** under Xcode 27.0 (release, 27A5209h):

- The app runs (no crash; UIScene lifecycle OK) and WebKit renders the SPA.
- All five intents + the `AppShortcutsProvider` are exported into the app's
  `Metadata.appintents/` bundle (with the NLU/phrase models) — confirmed by the
  `appintentsmetadataprocessor` and by inspecting `extract.actionsdata`. Each
  intent is `isDiscoverable`, `openAppWhenRun`, iOS 16.0+, with its Siri phrases.

**App-code fix found by the build:** a parameterized `AppShortcut` phrase
(`"Open \(\.$hubName) …"`) is rejected — a phrase parameter must be an
`AppEntity`/`AppEnum`, not a free-form `String`. The fix keeps the intent + its
`requestValueDialog` ("Which Hub?") and its `parameterSummary`, but drops the
parameter from the *phrase* (Siri asks for the Hub after triggering). This is
committed.

**Toolchain workarounds (local-only — not committed).** Tauri's mobile Swift glue
is built by [`swift-rs`](https://crates.io/crates/swift-rs) `1.0.7`, which
predates Xcode 27. Building on Xcode 27.0 needs three local fixes; none are app
code, so they live outside the repo (vendored `swift-rs` + a build-script tweak):

1. **SDK selection.** `swift-rs` runs `swift build --arch <arch>`, which makes
   SwiftPM pick the *macOS* SDK (`UIKit`/`OpenGLES/EAGL.h` not found). Replace
   `--arch` with `--triple <ios-triple>`, and resolve the output dir (Xcode 27
   writes to `out/Products/<Config>-iphonesimulator/`).
2. **`@_cdecl` symbol internalization.** Swift 6.4's *release*-mode whole-module
   optimization internalizes `swift-rs`'s C entry points to **local** linkage
   (`t _log_stdout`, not `T`), so nothing can link them. Build the Swift packages
   `-c debug` — they keep external linkage.
3. **Static-lib link propagation.** `swift-rs`'s `cargo:rustc-link-lib=static`
   (emitted from tauri's transitive build script) doesn't reach the final
   `aarch64-apple-ios-sim` link under Xcode 27, so `-lTauri`/`-ltauri_plugin_*`
   are dropped. Re-emit them from the **final crate's** `build.rs` (whose link
   directives do reach the link).

Once `swift-rs` ships Xcode-27 support these workarounds fall away and the app —
App Intents included — builds with no code changes.

## Possible follow-ups

- **Dynamic Hub suggestions in the Shortcuts editor.** Today "Open a Specific
  Hub" takes a free-form `String`. A full `AppEntity` + `EntityQuery` would let
  the editor auto-suggest the user's Hubs, but the query runs out-of-process and
  would need an **App Group** shared store populated from the app. Deferred.
- **Android parity** via App Shortcuts (`shortcuts.xml`) / Google Assistant App
  Actions — the Android analog of this iOS-only feature.
