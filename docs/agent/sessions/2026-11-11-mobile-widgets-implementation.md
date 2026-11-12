# Session Worksheet: mobile-widgets-implementation

## Meta

| Field | Value |
|-------|-------|
| **Slug** | mobile-widgets-implementation |
| **Date** | 2026-11-11 |
| **Agent** | Codex |
| **Model** | GPT-6 |
| **Task** | User request: build functional mobile and desktop widgets for Companion Hub and Companion Memory, document them, and prepare platform updates. |

## Goal

Add useful Companion Hub quick actions for iOS and Android, keep its desktop dashboard responsive, document the fixed destinations and limits, and verify the widgets in native builds. The launcher must not expose account credentials or claim live machine status that the mobile app does not provide.

## Steps taken

1. Added iOS WidgetKit and Android AppWidget quick actions for Open, Connect, Switch, and Settings, backed by fixed `cihub://intent/` destinations.
2. Fixed the generated Android Rust build task to use the Android project directory, added the widget preview and picker height, and updated Hub mobile/frontend documentation.
3. Built the Android debug app, installed the widget on an Android 14 emulator, and tapped Connect to verify it opened the login/connect screen.
4. Built the iOS widget target and an unsigned iOS IPA with the widget extension embedded; built the macOS `.app` and `.dmg`.
5. Captured the Android home-screen widget and documented the screenshot in the shared CI-Docs feature page.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Keep mobile Hub widgets as fixed quick actions. | The mobile app has no authenticated native status snapshot bridge; presenting machine metrics would be misleading. |
| Use immutable explicit deep links. | Each tile opens one in-app destination and does not accept arbitrary redirect paths or carry credentials. |
| Use the desktop dashboard for current system information. | The responsive Hub app already has the authenticated live data surface; the mobile launcher is intentionally small. |

## Files touched

- `packages/mobile/src-tauri/gen/apple/WidgetExtension/`
- `packages/mobile/src-tauri/gen/apple/project.yml`
- `packages/mobile/src-tauri/gen/android/app/src/main/`
- `packages/mobile/src-tauri/gen/android/buildSrc/src/main/java/computer/ci/app/hub/kotlin/BuildTask.kt`
- `packages/mobile/src-tauri/gen/android/buildSrc/src/main/java/computer/ci/app/hub/kotlin/RustPlugin.kt`
- `packages/mobile/README.md`
- `docs/system/frontend.md`
- `docs/agent/sessions/2026-11-11-mobile-widgets-implementation-feedback.md`
- `docs/agent/WORKFLOW_FEEDBACK.md`

## Tests run

- [x] `./gradlew testUniversalDebugUnitTest` — passed; Android widget tests included.
- [x] `pnpm --filter frontend exec vitest run src/mobile-store-readiness.test.ts` — 38/38 passed.
- [x] `pnpm --filter frontend exec vitest run src/hooks/use-app-intent-deep-links.test.tsx src/lib/app-intents.test.ts` — 29/29 passed.
- [x] Direct iOS simulator build of `CompanionHubWidgets` — passed.
- [x] `pnpm --filter mobile exec tauri ios build --debug --no-sign --ci --target aarch64` — passed; widget extension embedded in the unsigned IPA.
- [x] `pnpm --filter mobile exec tauri android build --debug --apk --ci` — passed; installed on Android 14 emulator and Connect tile opened the app's login/connect screen.
- [x] Hub macOS packaging — passed; the app bundle and DMG were produced.
- [x] `git diff --check` — passed.
- [ ] `bin/agent-validate-shift` — attempted; stopped at `lint:ci` with 4 existing errors and 3 warnings in untouched backend training files, so its downstream checks did not run.

## Open items / handoff

- PR remains unmerged; no store signing, TestFlight upload, Play upload, or public release was performed.
- Android behavior was exercised on an Android 14 emulator, not a physical phone.
- macOS packaging falls back to the nearest published Hub backend release `2026.11.10`, so it does not contain this checkout's exact backend source.
- The end-of-shift validator is currently red on untouched backend training files; focused widget and mobile-intent suites passed.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| Platform QA | Mobile app user | GPT-6 | Confirmed four home-screen actions; tapped Connect and reached the login/connect screen. |
| Security review | Privacy reviewer | GPT-6 | Fixed routes only; no credentials or live machine metrics are stored in the widget. |
