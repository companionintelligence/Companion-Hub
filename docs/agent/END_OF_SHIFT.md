# End of Shift — CI-Hub

> **Purpose:** Final validation checklist before an agent session ends.
> **Scope:** All coding sessions; run via `bin/agent-validate-shift`.
> **Gate script:** `bin/agent-validate-shift` / `pnpm run agent:validate`
> **Workflow:** [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md)
> **Router:** [AGENTS.md](../../AGENTS.md)
> **Last updated:** 2026-07-12
> **Related:** ci-checks.mdc, TESTING.md

---

## Automated gate

```bash
bin/agent-validate-shift
# equivalent: pnpm run agent:validate
```

The script runs these steps in order and stops on first failure:

| Step | Command | When skipped |
|------|---------|--------------|
| 1. Lint | `pnpm run lint:ci` | Never |
| 2. Typecheck | `pnpm run tsc` | Never |
| 3. Unit tests | `pnpm run test` | Never |
| 4. OpenAPI drift | `pnpm run check:openapi` | Docs-only changes (use `--skip-openapi`) |
| 5. Visual regression | `pnpm run test:visual` | No UI changes (use `--skip-visual`) |
| 6. Benchmark gate | `pnpm run benchmark:gate` | No perf-sensitive changes (use `--skip-benchmark`) |

---

## Manual checklist

Complete these even if automated steps pass:

- [ ] **App was run** — `pnpm run local` or `local:desktop` during implementation
- [ ] **System docs updated** — relevant `docs/system/*.md` reflects your changes
- [ ] **Session worksheet** — copied to `docs/agent/sessions/` and committed
- [ ] **Session feedback** — filled and committed
- [ ] **Cross-agent review** — at least one `bin/agent-review --phase wrap` with a different persona/model
- [ ] **TODO.md updated** — task moved out of `## In Progress`
- [ ] **No secrets committed** — no `.env`, tokens, or credentials in diff
- [ ] **Scoped tests added** — new behavior has test coverage per TESTING.md

---

## Optional deep validation

For large or risky changes, also run:

```bash
pnpm run test:integration     # backend + Docker deps
pnpm run check                # full lint + tsc + build + test
bin/agent-sweep --since 1.day # cross-commit gotcha scan
```

---

## After merge

```bash
git tag agent-session/<worksheet-slug>
git push origin agent-session/<worksheet-slug>
```
