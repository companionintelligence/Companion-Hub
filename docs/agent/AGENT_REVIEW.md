# Agent review

> **Purpose:** Cross-agent review protocol at research, plan, implementation, and wrap-up phases.
> **Scope:** All non-trivial changes; use different models per phase.
> **CLI:** `bin/agent-review --phase <phase> --persona <persona>`
> **Personas:** [REVIEW_PERSONAS.md](REVIEW_PERSONAS.md)
> **Router:** [AGENTS.md](../../AGENTS.md)
> **Last updated:** 2026-07-12
> **Related:** AGENT_WORKFLOW.md, CODING_CONVENTIONS.md

---

## Review phases

| Phase | When | Focus | Model rule |
|-------|------|-------|------------|
| `research` | Before planning | Correct problem, right docs read, scope sane | Any reviewer |
| `plan` | Before coding | Architecture fit, test plan, file list | **Different** from research |
| `impl` | Mid-implementation | Code quality, edge cases, conventions | **Different** from plan |
| `wrap` | Before PR / end of shift | Security, regressions, docs, tests | **Different** from impl |

**Rule:** The same model must not review its own implementation. Rotate Cursor, Claude, Codex, or Copilot.

---

## Running review

```bash
# Print review prompt for the phase + persona
bin/agent-review --phase wrap --persona security

# Cursor-specific: launches Bugbot or Security Review subagent when available
bin/agent-review --phase impl --persona code-quality --cursor
```

The script outputs a structured prompt. Paste the prompt into a **different** agent session, or use `--cursor` to invoke subagents.

---

## Minimum review bar

| Change size | Required reviews |
|-------------|------------------|
| Docs only | 1× `wrap` / maintainability |
| Single package bugfix | 1× `wrap` / code-quality |
| Cross-package feature | `plan` + `wrap` / security + code-quality |
| Auth, Docker, network | `wrap` / security (mandatory) |
| UI layout change | `wrap` / code-quality + visual regression check |

---

## What reviewers check

### All phases
- Matches [CODING_CONVENTIONS.md](CODING_CONVENTIONS.md)
- Relevant `docs/system/*.md` updated
- Tests exist for new behavior

### Security persona
- No secrets in diff
- Input validation on new endpoints
- Docker socket / privilege boundaries respected

### Performance persona
- No N+1 queries
- Benchmark impact considered
- `pnpm run benchmark:gate` if perf-sensitive

### AI smells persona
- Over-engineering, unnecessary abstractions
- Hallucinated APIs or paths
- Tests that don't test real behavior

---

## Cursor subagent mapping

| Persona | Cursor subagent |
|---------|-----------------|
| code-quality | Bugbot (`review-bugbot` skill) |
| security | Security Review (`review-security` skill) |
| maintainability | General review prompt |
| performance | Benchmark + profile review prompt |
| ai-smells | test-audit skill + review prompt |
