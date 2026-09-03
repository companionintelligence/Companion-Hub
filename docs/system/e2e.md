# End-to-end testing — Companion Hub

> **Purpose:** Playwright e2e, visual regression, fleet QA, performance benchmarks.
> **Scope:** `e2e/`, `playwright*.config.ts`, `scripts/benchmark-app.ts`, `scripts/run-e2e.ts`
> **Key paths:** `e2e/`, `e2e/visual/`, `e2e/helpers/screenshot.ts`, `scripts/agent/benchmark-gate.ts`
> **Commands:** `pnpm run test:e2e:ci`, `pnpm run test:visual`, `pnpm run benchmark:gate`
> **Owner persona:** code-quality + performance
> **Last updated:** 2026-07-12
> **Related:** docs/agent/TESTING.md, docs/agent/TEST_INVENTORY.md, docs/FLYWHEEL.md

---

## Playwright lanes

| Config | Lane | When to run |
|--------|------|-------------|
| `playwright.config.ts` | Default | Auth, dashboard, store, lifecycle |
| `playwright.cross-domain.config.ts` | Cross-domain | Hub ↔ Portal flows |
| `playwright.future-onboarding.config.ts` | Future onboarding | AI setup flows |
| `playwright.mcp.config.ts` | MCP | OpenClaw integration + the external connect recipe (`pnpm e2e:mcp`) |

Local full stack: `pnpm run test:e2e` (docker-compose + Playwright via `scripts/run-e2e.ts`).

## CI coverage

| Workflow | Trigger | What runs |
|----------|---------|-----------|
| `ci.yml` | Every PR | lint, tsc, unit tests (not e2e) |
| `e2e.yml` | Release / manual | Default Playwright |
| `e2e-extended.yml` | Nightly / label | Cross-domain + future |
| `e2e-mcp.yml` | Manual dispatch only | MCP connect recipe — protocol handshake + app env injection (12 tests) |
| `agent-gates.yml` | PR (optional) | Visual + benchmark gates |

`e2e-mcp.yml` is dispatch-only on purpose: it boots a backend, so it earns its runner minutes only
when the MCP surface, its auth, or the connect docs change. Run it with
`gh workflow run e2e-mcp.yml --ref <branch>`, or `pnpm e2e:mcp` locally for the full 18-test lane
including the Docker-heavy install layer.

## Visual regression

- Specs: `e2e/visual/`
- Baselines: `e2e/screenshots/baselines/` (tracked)
- Actual/diff: `e2e/screenshots/actual/`, `diff/` (gitignored)
- Helper: `e2e/helpers/screenshot.ts` (pixelmatch)
- Run: `pnpm run test:visual`

## Performance benchmarks

```bash
# Per-app resource benchmark (manual / fleet)
pnpm exec tsx scripts/benchmark-app.ts <app-id>

# Gate against checked-in baseline
pnpm run benchmark:gate
```

Baselines: `e2e/results/benchmarks/baseline.json`

Fleet QA orchestration (private ops) is tracked under companionintelligence/CI-Engineering#211 — inventories and runners are not in this tree.

## Agent notes

- App Explorer (`e2e/app-explorer.spec.ts`) is for marketplace QA — see FLYWHEEL.md
- Generated catalog tests: `e2e/generated/catalog-batch-*.spec.ts`
- Regenerate test inventory: `pnpm run agent:test-inventory`
