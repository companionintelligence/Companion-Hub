# Review Personas — CI-Hub

> **Purpose:** Persona definitions for cross-agent review; each owns system docs.
> **Scope:** Security, performance, maintainability, code quality, AI smells, domain.
> **CLI:** `bin/agent-review --persona <name>`
> **Docs owned:** Listed per persona below — keep updated when reviewing that area.
> **Router:** [AGENTS.md](../../AGENTS.md)
> **Last updated:** 2026-07-12
> **Related:** AGENT_REVIEW.md, docs/system/

---

## Persona matrix

| Persona | `--persona` flag | Lens | System docs owned |
|---------|------------------|------|-------------------|
| Security | `security` | Auth, secrets, Docker privileges, input validation | `docs/system/backend.md`, `docs/system/desktop.md` |
| Performance | `performance` | Benchmarks, query efficiency, startup time | `docs/system/e2e.md`, `docs/system/backend.md` |
| Maintainability | `maintainability` | Structure, naming, module boundaries | `docs/system/README.md`, all system docs |
| Code quality | `code-quality` | Bugs, edge cases, test coverage | `docs/system/frontend.md`, `docs/agent/TESTING.md` |
| AI smells | `ai-smells` | Over-abstraction, false tests, hallucinated paths | `docs/agent/CODING_CONVENTIONS.md`, `docs/agent/TEST_INVENTORY.md` |
| Domain (marketplace) | `domain` | App install flows, compose correctness | `docs/system/agent-qa.md`, `docs/FLYWHEEL.md` |

---

## Security persona

**Looks for:**
- Hardcoded credentials, `.env` leaks
- Missing auth guards on new endpoints
- `privileged: true` or excessive capabilities in compose
- SSRF in URL-fetching code

**Commands:**
```bash
bin/agent-review --phase wrap --persona security
```

---

## Performance persona

**Looks for:**
- Unbounded queries or missing pagination
- Synchronous work in hot paths
- Missing indexes for new queries
- Frontend re-render storms

**Commands:**
```bash
pnpm run benchmark:gate
pnpm exec tsx scripts/benchmark-app.ts <app-id>
```

---

## Maintainability persona

**Looks for:**
- Files in wrong package
- Duplicated logic that should reuse existing helpers
- Missing updates to `docs/system/*.md`
- Breaking changes without migration notes

---

## Code quality persona

**Looks for:**
- Missing error handling
- Incorrect TypeScript types (especially test mocks)
- Biome violations
- Tests that don't assert meaningful outcomes

**Cursor:** Use Bugbot subagent via `bin/agent-review --phase wrap --persona code-quality --cursor`

---

## AI smells persona

**Looks for:**
- One-line helpers that should be inline
- Comments explaining obvious code
- Tests with always-true assertions
- Imports from wrong packages (`agent/` into Hub packages)

**Skill:** `.cursor/skills/test-audit/SKILL.md`

---

## Domain (marketplace) persona

**Looks for:**
- `config.json` / `docker-compose.json` correctness
- Install form field mapping
- Fleet QA compatibility

**Only for:** marketplace QA work — see FLYWHEEL.md
