# Session Feedback: mobile-widgets-implementation

## Session

| Field | Value |
|-------|-------|
| **Worksheet** | `docs/agent/sessions/2026-11-11-mobile-widgets-implementation.md` |
| **Date** | 2026-11-11 |

## What worked

- A real Android 14 emulator install and tap verified that the Connect quick action reaches the app's login/connect screen.
- A fixed-destination route model kept the native widgets useful without copying Hub account or machine state into launcher storage.
- Building Android through the Tauri CLI supplied the local CLI options server required by the generated Rust tasks.

## Friction / blockers

- Running the generated Android Gradle task outside the Tauri CLI failed because the CLI options server file was absent; using the project CLI succeeded.
- The iOS build rewrote generated project data with the host process's full PATH. That value was normalized before commit to avoid leaking host-specific paths.
- The macOS bundle uses the nearest published backend release when the current checkout is not tagged for publication.

## Workflow improvements

- Add a generated-project check that rejects user-specific paths and runtime directories in Xcode project build scripts.
- Document that the generated Android Rust tasks must be invoked through the Tauri CLI unless the CLI options server has been started.

## Tooling gaps

- A simple scripted simulator action would make the iOS widget picker and deep-link smoke check repeatable without manual UI interaction.

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-11-11 — mobile-widgets-implementation: Added and emulator-checked fixed Hub quick actions; recorded Tauri build and generated Xcode path pitfalls.
