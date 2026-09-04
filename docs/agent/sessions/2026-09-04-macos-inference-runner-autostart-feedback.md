## Session

| Field | Value |
|-------|-------|
| **Worksheet** | `docs/agent/sessions/2026-09-04-macos-inference-runner-autostart.md` |
| **Date** | 2026-09-04 |

## What worked

- The existing desktop runner boundary kept native installation and process lifecycle out of browser code.
- Package-filtered tests and Rust unit tests covered the security/lifecycle changes without touching live model services.
- A separate worktree kept the user's active checkout and running FTUE environments intact.

## Friction / blockers

- The globally installed pnpm package was 10.x even though Corepack reported the project-pinned 11.5.1; invoking the pinned Corepack binary directly avoided the engine mismatch.
- Existing local Hub processes occupied the standard source-development ports, so the built frontend was smoked on port 5025 against the already-running local API rather than replacing those sessions.
- The review helper prints prompts for a different agent but no separate review agent was available in this task.

## Workflow improvements

- Have validation helpers invoke the repository `packageManager` version directly instead of relying on a globally installed pnpm child process.
- Add a pure LaunchAgent/plist validation helper to the desktop test utilities for other per-user services.

## Tooling gaps

- A non-interactive cross-model review command would let the documented review rotation complete inside one Codex task.

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-09-04 — macos-inference-runner-autostart: Exact FTUE runner installs now use compatible Python, private credentials, and resilient macOS login services.
