# AGENTS.md — CI-Hub Router

> **Start here.** This file routes you to skills, docs, tools, and workflows. Do not duplicate content from linked files — follow the links.

Private & Confidential — Property of Lifescope Inc.

---

## Quick start

1. Tag **`@docs/agent/AGENT_WORKFLOW.md`** in every coding session.
2. Check **`TODO.md`** for queued work.
3. Read the relevant **`docs/system/*.md`** doc before touching that area.
4. Finish with **`bin/agent-validate-shift`** before marking work done.

---

## Workflow & queue

| Resource | When to use |
|----------|-------------|
| [docs/agent/AGENT_WORKFLOW.md](docs/agent/AGENT_WORKFLOW.md) | Standard session flow (research → plan → implement → run → test → review → validate) |
| [docs/agent/END_OF_SHIFT.md](docs/agent/END_OF_SHIFT.md) | Final checklist before ending a session |
| [TODO.md](TODO.md) | Agent task queue (`## Ready`, `## In Progress`, `## Blocked`) |

---

## System docs (self-healing)

Living docs agents **must update** when they change a system. Every doc starts with a **7-line `>` summary block** (greppable via `rg "^>" docs/system/`).

| Doc | System |
|-----|--------|
| [docs/system/README.md](docs/system/README.md) | Index + header format spec |
| [docs/system/backend.md](docs/system/backend.md) | NestJS API, Drizzle, queues |
| [docs/system/frontend.md](docs/system/frontend.md) | React Router, hub-status, API client |
| [docs/system/desktop.md](docs/system/desktop.md) | Tauri, hub_manager, compose lifecycle |
| [docs/system/e2e.md](docs/system/e2e.md) | Playwright lanes, benchmarks, visual tests |
| [docs/system/agent-qa.md](docs/system/agent-qa.md) | Marketplace QA flywheel (separate from general workflow) |

Deep architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (links to `docs/system/`).

> **Deprecated for agents:** `.github/memory-bank/*` — use `docs/system/` instead.

---

## Testing

| Resource | Purpose |
|----------|---------|
| [docs/agent/TESTING.md](docs/agent/TESTING.md) | How to write tests; anti-patterns |
| [docs/agent/TEST_INVENTORY.md](docs/agent/TEST_INVENTORY.md) | Every spec file and what it asserts |
| [e2e/README.md](e2e/README.md) | Playwright lanes and local commands |

Regenerate inventory: `pnpm run agent:test-inventory`

---

## Review & conventions

| Resource | Purpose |
|----------|---------|
| [docs/agent/AGENT_REVIEW.md](docs/agent/AGENT_REVIEW.md) | Cross-agent review at each phase |
| [docs/agent/REVIEW_PERSONAS.md](docs/agent/REVIEW_PERSONAS.md) | Security, perf, maintainability, AI smells personas |
| [docs/agent/CODING_CONVENTIONS.md](docs/agent/CODING_CONVENTIONS.md) | Conventions Biome does not enforce |

Run review: `bin/agent-review --phase impl --persona security`

---

## Session traceability

| Resource | Purpose |
|----------|---------|
| [docs/agent/SESSION_WORKSHEET.template.md](docs/agent/SESSION_WORKSHEET.template.md) | Per-session trace (commit with your work) |
| [docs/agent/SESSION_FEEDBACK.template.md](docs/agent/SESSION_FEEDBACK.template.md) | End-of-session workflow feedback |
| [docs/agent/WORKFLOW_FEEDBACK.md](docs/agent/WORKFLOW_FEEDBACK.md) | Rolling aggregate for periodic review |
| [docs/agent/sessions/](docs/agent/sessions/) | Committed session worksheets |

Git tag after merge: `agent-session/<worksheet-slug>`

---

## Skills (Cursor / Claude)

| Skill | Path | Use when |
|-------|------|----------|
| Agent workflow | `.cursor/skills/agent-workflow/SKILL.md` | Starting any session |
| Agent loop / night shift | `.cursor/skills/agent-loop/SKILL.md` | Autonomous work against TODO.md |
| Agent sweep | `.cursor/skills/agent-sweep/SKILL.md` | Scan recent commits for gotchas |
| Test audit | `.cursor/skills/test-audit/SKILL.md` | Find false-confidence tests |
| Visual regression | `.cursor/skills/visual-regression/SKILL.md` | Screenshot baselines |
| Fleet QA | `.claude/skills/run-fleet-qa/SKILL.md` | Marketplace app QA across fleet |

Claude mirrors live under `.claude/skills/` (same content as `.cursor/skills/` where present).

---

## Bin scripts & tools

| Script | Purpose |
|--------|---------|
| `bin/agent-review` | Cross-agent review CLI |
| `bin/agent-validate-shift` | End-of-shift validation gate |
| `bin/agent-sweep` | Recent-commit gotcha scan |
| `bin/cihub.cjs` | Published Hub CLI |

Authoring guide: [docs/agent/SCRIPT_AUTHORING.md](docs/agent/SCRIPT_AUTHORING.md)

Package.json shortcuts: `pnpm run agent:validate`, `agent:review`, `agent:sweep`, `test:visual`, `benchmark:gate`

---

## Marketplace QA flywheel (specialized)

For **ci-marketplace app exploration and auto-fix PRs** only — not general feature development:

- [docs/FLYWHEEL.md](docs/FLYWHEEL.md)
- `agent/` dev tooling (separate npm lockfile; not in pnpm workspace or CI)

---

## Run the app (mandatory)

Agents **must run the Hub** and verify changes before finishing:

```bash
pnpm install
pnpm run local          # source-based stack (frontend :5004, backend :5002)
pnpm run local:desktop  # Tauri desktop against local stack
pnpm run dev            # appliance stack (.env.dev)
```

Scoped checks: see [`.cursor/rules/ci-checks.mdc`](.cursor/rules/ci-checks.mdc)

---

## Git discipline

- Never `git reset --hard` or `git clean -f` without user confirmation.
- Commit messages: imperative mood, ≤ 72 chars.
- Reference CI-Engineering issues in PRs (e.g. `Closes companionintelligence/CI-Engineering#32`).
- Multiple agents may work simultaneously — never use destructive git operations.

## Packages layout

`packages/backend/` · `packages/frontend/` · `packages/desktop/` · `packages/common/`
