---
name: agent-loop
description: Autonomous night-shift loop for CI-Hub. Picks tasks from TODO.md and runs AGENT_WORKFLOW phases without user prompts.
---

# Agent Loop / Night Shift — CI-Hub

Autonomous work against [TODO.md](../../TODO.md).

## Loop

1. Read [docs/agent/AGENT_WORKFLOW.md](../../docs/agent/AGENT_WORKFLOW.md)
2. Take top item from `## Ready` → move to `## In Progress`
3. Run phases: research → plan → implement → test → review → document → validate
4. On success: move task to `## Done (recent)` with date
5. On blocker: move to `## Blocked` with reason
6. Run `bin/agent-sweep --since 1.day` before final validate
7. Run `bin/agent-validate-shift`
8. Repeat until `## Ready` is empty or time budget exhausted

## Cursor /loop integration

Use the loop skill with interval, e.g. `/loop 30m` + prompt:

> Continue agent loop on TODO.md. Follow .cursor/skills/agent-loop/SKILL.md. One task per iteration.

## Constraints

- Never destructive git without user confirmation
- Do not import from `agent/` into Hub packages
- Update `docs/system/*.md` when changing systems
