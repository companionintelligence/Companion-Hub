# Companion Hub system documentation

> **Purpose:** Index of living system docs agents must keep updated when changing code.
> **Scope:** Backend, frontend, desktop, e2e, agent QA, Marketplace app portability.
> **Format:** Every doc starts with a 7-line `>` summary block (this file included).
> **Grep:** `rg "^>" docs/system/` finds all summaries.
> **Router:** [AGENTS.md](../../AGENTS.md)
> **Last updated:** 2026-10-30
> **Related:** ARCHITECTURE.md, docs/agent/AGENT_WORKFLOW.md, marketplace-app-portability.md

---

## 7-line header format

Every `docs/system/*.md` file **must** begin with exactly this block (fill in values):

```markdown
> **Purpose:** One sentence — what this system does.
> **Scope:** Packages, directories, or features covered.
> **Key paths:** Comma-separated paths agents grep first.
> **Commands:** Dev/test commands specific to this system.
> **Owner persona:** From REVIEW_PERSONAS.md who reviews changes here.
> **Last updated:** YYYY-MM-DD
> **Related:** Other docs to read.
```

When you change a system, update the `Last updated` field and the relevant sections.

---

## System docs

| Doc                                                              | System                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| [backend.md](backend.md)                                         | NestJS API, Drizzle ORM, PostgreSQL, RabbitMQ workers         |
| [frontend.md](frontend.md)                                       | React Router 7 SPA, hub-status gate, API client               |
| [desktop.md](desktop.md)                                         | Tauri 2 shell, hub_manager, Docker compose lifecycle          |
| [e2e.md](e2e.md)                                                 | Playwright tests, visual regression, benchmarks               |
| [agent-qa.md](agent-qa.md)                                       | Marketplace QA flywheel (FLYWHEEL)                            |
| [marketplace-app-portability.md](marketplace-app-portability.md) | Third-party agent packaging, proxy trust, and Hub integration |

For more detail, see [Companion Hub architecture](../ARCHITECTURE.md).
