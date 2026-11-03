# Session Feedback — QA procfs fast readiness

## Session

| Field | Value |
|-------|-------|
| **Worksheet** | `docs/agent/sessions/2026-11-01-qa-procfs-fast-readiness.md` |
| **Date** | 2026-11-01 |

## What worked

- A targeted fleet run caught that static procfs parser tests did not prove the actual remote runner could use the signal.
- Host-side inspection confirmed the database listener was present without relying on tools inside the image.

## Friction / blockers

- The old readiness path spent 450 seconds polling HTTP before trying the known-protocol listener fallback.
- The skip result did not state why the procfs inspection was unknown.
- Independent reviews caught broad image-family recognition, Docker proxy handshakes, loopback-only binds, and IPv6-only proxy ambiguity; IPv4 listener evidence is required while unsupported IPv6-only evidence stays unknown.

## Workflow improvements

- Check only known protocol endpoints during readiness, verify published plus internal reachability, and record inspection failures in the result row.
- Rerun a focused app through the actual fleet controller after changing the copied runner.

## Tooling gaps

- The fleet dashboard should show procfs inspection details while an app is running, not only the final score.

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-11-01 — qa-procfs-fast-readiness: Require IPv4 published reachability and an IPv4 wildcard/container listener on known protocol ports, preserve HTTP probes elsewhere, and keep unverified IPv6-only binds unknown.
