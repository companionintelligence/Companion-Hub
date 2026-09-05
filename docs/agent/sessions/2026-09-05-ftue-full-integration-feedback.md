# Session Feedback — FTUE full integration

## Session

| Field | Value |
|-------|-------|
| **Worksheet** | `docs/agent/sessions/2026-09-05-ftue-full-integration.md` |
| **Date** | 2026-09-05 |

## What worked

- The existing Playwright web-server configuration made it possible to run the actual frontend and backend on isolated ports.
- Deterministic inference fixtures covered protocol and recovery behavior without changing installed host services.
- A real queue worker and digest-pinned Docker fixture validated the app-installer path end to end.
- The isolated worktree and resource names preserved the user's active checkout and running Hub.
- A dedicated runner now preserves healthy test infrastructure and owns only the services it starts.

## Friction / blockers

- The package-level E2E cleanup initially removed infrastructure that the focused FTUE lane still needed; the dedicated runner now resolves that lifecycle mismatch.
- A live backend initially consumed jobs from the test backend because queue names were global; the new optional prefix closes that isolation gap.
- Shared Cloudflare container startup emits unrelated conflict noise even though the isolated lane does not depend on it.
- `AGENTS.md` and the workflow reference `docs/agent/WORKFLOW_FEEDBACK.md`, but that file was absent.

## Workflow improvements

- Apply the focused FTUE runner's ownership model to other extended E2E lanes.
- Make a per-run queue prefix part of the standard local E2E environment.
- Add an explicit native Apple Silicon release-smoke lane for Homebrew, LaunchAgent, and first model-download validation.

## Tooling gaps

- The review helper produces prompts but cannot invoke a separate review model in this environment.
- The installer harness would benefit from a first-class minimal multi-architecture Docker fixture with a local health endpoint.

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-09-05 — ftue-full-integration: Ten full-stack FTUE browser scenarios now cover inference recovery, persisted setup, model pulls, and a real Docker app installation with isolated queues.
