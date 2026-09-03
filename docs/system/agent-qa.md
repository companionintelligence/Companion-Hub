# Agent QA System — CI-Hub

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
