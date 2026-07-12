---
name: agent-workflow
description: Load CI-Hub standard agent workflow and task queue. Use when starting any coding session in ci-hub.
---

# Agent Workflow Skill — CI-Hub

Read and follow these files in order:

1. [AGENTS.md](../../AGENTS.md) — router
2. [docs/agent/AGENT_WORKFLOW.md](../../docs/agent/AGENT_WORKFLOW.md) — session phases
3. [TODO.md](../../TODO.md) — pick or update queued work
4. Relevant [docs/system/](../../docs/system/) doc for the area you will touch

## Session rules

- Run the app: `pnpm run local` or `pnpm run local:desktop`
- Finish with: `bin/agent-validate-shift`
- Commit session worksheet to `docs/agent/sessions/`
- Cross-agent review before PR: `bin/agent-review --phase wrap`

Do not use FLYWHEEL.md for general feature work — marketplace QA only.
