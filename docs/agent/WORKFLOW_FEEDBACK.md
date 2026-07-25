# Workflow Feedback — CI-Hub

> Rolling aggregate of agent session feedback. Review periodically to improve AGENT_WORKFLOW.md, skills, and scripts.
> Template: [SESSION_FEEDBACK.template.md](SESSION_FEEDBACK.template.md)

---

## Entries

<!-- Format: - YYYY-MM-DD — slug: one-line summary -->

- 2026-07-12 — agentic-workflow-toolchain: Initial agent toolchain bootstrap on chore/agentic-workflow-toolchain branch.
- 2026-07-25 — local-dev-app-dir: Fixed `ensureLocalDevRuntimeEnv` to remap `CI_HUB_APP_DIR` for source-based local dev (was breaking Cloudflare Tunnel with EACCES + wrong compose-file path); surfaced that `CI_HUB_TUNNEL_DIR` is dead-on-arrival due to a turbo.json env allowlist gap.
