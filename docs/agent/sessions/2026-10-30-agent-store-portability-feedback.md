# Session Feedback

## Session

| Field         | Value                                                     |
| ------------- | --------------------------------------------------------- |
| **Worksheet** | docs/agent/sessions/2026-10-30-agent-store-portability.md |
| **Date**      | 2026-10-30                                                |

## What worked

- Reading the exact pinned store A image tag exposed a trust-boundary mismatch that a current-branch-only review would have missed.
- Store B manifests provided concrete defaults for sender allowlists, internal API entrances, and opt-in data access.

## Friction / blockers

- The OpenClaw adapter is duplicated between Hub fallback data and Marketplace app payload, so source drift can silently change installed behavior.
- Runtime compatibility is not established until the app can be installed and tested on Hub.

## Workflow improvements

- Add a CI or generated-manifest check that ensures the Hub fallback OpenClaw adapter matches the Marketplace payload.
- Add a marketplace gate that detects app images whose auth depends on a vendor-specific proxy identity.

## Tooling gaps

- A source-aware app package inspector could compare app image entrypoint behavior, exposed ports, and proxy auth assumptions before promotion.

## One-line summary (for WORKFLOW_FEEDBACK.md)

> 2026-10-30 — agent-store-portability: Compared the agent packaging of store A and store B, documented Hub trust boundaries, and recorded the OpenClaw wrapper quarantine and cross-repo bootstrap sync.
