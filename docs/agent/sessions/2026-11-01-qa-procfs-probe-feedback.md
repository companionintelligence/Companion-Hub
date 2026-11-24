# Session feedback: Linux fleet TCP readiness probe

## Session

| Field | Value |
|-------|-------|
| **Worksheet** | `docs/agent/sessions/2026-11-01-qa-procfs-probe.md` |
| **Date** | 2026-11-01 |

## What worked

- Reading `/proc/<container-pid>/net` on Linux verifies the container network namespace without asking an app image to provide trusted tools.
- Exact image-path assertions make the silent-protocol exception auditable.

## Friction / blockers

- The fleet run takes the generic five-minute readiness ceiling for a no-GUI database even when it is plainly listening, delaying targeted QA feedback.
- Docker Desktop's VM boundary prevents the same procfs read from a macOS host; the safe result is unknown until a trusted cross-platform probe is available.

## Workflow improvements

- Consider a protocol-specific PostgreSQL/SQL Server readiness probe to avoid a full generic HTTP polling window while retaining positive database readiness evidence.

## Tooling gaps

- The dashboard should show harness commit/probe capability next to each run and reject or clearly label a run whose harness source is dirty or not shipped.

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-11-01 — qa-procfs-probe: Read Linux container sockets through trusted host procfs, constrain SQL Server image evidence, and test unsupported-platform uncertainty.
