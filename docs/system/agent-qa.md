# Agent QA system — Companion Hub

> **Purpose:** Marketplace app exploration, diagnose/fix loop — separate from general dev workflow.
> **Scope:** `agent/`, `e2e/app-explorer.spec.ts`, `docs/FLYWHEEL.md`
> **Key paths:** `agent/fix-agent.ts`, `agent/lib/diagnostics.ts`, `docs/FLYWHEEL.md`
> **Commands:** `agent/scripts/run-explorer.sh`
> **Owner persona:** domain (marketplace/apps)
> **Last updated:** 2026-09-03
> **Related:** docs/system/e2e.md, docs/agent/AGENT_WORKFLOW.md (general work)

---

## Not general development

This system is **only** for ci-marketplace app QA automation. Feature work and bugfixes use [AGENT_WORKFLOW.md](../agent/AGENT_WORKFLOW.md).

## Flywheel loop

```
EXPLORE  → app-explorer.spec.ts installs + AI-explores apps
DIAGNOSE → agent/lib/diagnostics.ts classifies failures
FIX      → agent/fix-agent.ts patches ci-marketplace → opens PR
```

Full guide: [docs/FLYWHEEL.md](../FLYWHEEL.md)

## agent/ directory

- Separate npm lockfile — **not** in pnpm workspace
- **Do not import** from `agent/` into Hub packages
- Not run in standard CI (`ci.yml`)

## Fleet QA

Multi-node Tailscale fleet runners and host inventories are **not published** in this repository
(companionintelligence/CI-Hub#1210 / companionintelligence/CI-Engineering#211). Use local
`scripts/qa-stream.ts` against a single machine, or the private ops mirror for fleet orchestration.

## Agent notes

- Status server: `agent/status-server.ts` (port 3099)
- Reports written to `agent/results/`
- For general Hub development, ignore this system unless explicitly doing marketplace QA

## Remote runner control

The private fleet QA controller may copy `scripts/qa-stream.ts` to a node and set
`QA_RUN_PID_FILE` to a run-specific marker path. The runner writes its PID there, drains active
app checks when it receives `SIGTERM` or `SIGINT`, and removes the marker on exit. This is a
scoped stop contract: operators and controllers must close the work feed or signal the recorded
PID, never use a fleet-wide `pkill` that could terminate another QA session.

When that marker contains a fleet run token, the runner also namespaces its Docker container names
and Compose project names with the token. This keeps an orphaned resource from an earlier run from
blocking a later run for the same app. Direct `qa-stream.ts` CLI use without `QA_RUN_PID_FILE`
keeps the legacy names for compatibility.
