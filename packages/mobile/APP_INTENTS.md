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

> **Known caveat:** on-device iOS builds are currently blocked by the
> `swift-rs` × Xcode 27 beta issue documented in `README.md`. The App Intents
> code, project wiring, Rust capture, and frontend routing are complete and the
> JS/Rust layers are unit-tested; full on-device verification is pending an
> unblocked iOS toolchain.

## Possible follow-ups

- **Dynamic Hub suggestions in the Shortcuts editor.** Today "Open a Specific
  Hub" takes a free-form `String`. A full `AppEntity` + `EntityQuery` would let
  the editor auto-suggest the user's Hubs, but the query runs out-of-process and
  would need an **App Group** shared store populated from the app. Deferred.
- **Android parity** via App Shortcuts (`shortcuts.xml`) / Google Assistant App
  Actions — the Android analog of this iOS-only feature.
