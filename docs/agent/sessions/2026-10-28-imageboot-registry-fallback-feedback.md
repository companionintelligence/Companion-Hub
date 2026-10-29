# Session Feedback

## Session

| Field | Value |
|-------|-------|
| **Worksheet** | `docs/agent/sessions/2026-10-28-imageboot-registry-fallback.md` |
| **Date** | 2026-10-28 |

## What worked

- A registry fallback keeps a public-registry outage from being misreported as a Hub boot regression.
- Showing pull stderr makes remaining registry failures diagnosable from one workflow run.

## Friction / blockers

- The local Docker daemon is stopped, so container-level verification must run on GitHub Actions.

## Workflow improvements

- Keep a real image-boot run required for changes to this smoke-test script.

## Tooling gaps

- None identified.

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-10-28 — imageboot-registry-fallback: Retry Docker Hub and fall back to public ECR for image-boot dependencies, with registry errors visible.
