# End-to-end testing — Companion Hub

> **Purpose:** Playwright e2e, visual regression, fleet QA, performance benchmarks.
> **Scope:** `e2e/`, `playwright*.config.ts`, `scripts/benchmark-app.ts`, `scripts/run-e2e.ts`
> **Key paths:** `e2e/`, `e2e/future/`, `e2e/visual/`, `playwright.future-onboarding.config.ts`
> **Commands:** `pnpm run test:e2e:ci`, `pnpm e2e:future:onboarding`, `pnpm run test:visual`
> **Owner persona:** code-quality + performance
> **Last updated:** 2026-09-05 (FTUE full-integration lane)
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

## FTUE full integration

The future-onboarding lane runs the current one-page FTUE against the real frontend, compiled
backend, PostgreSQL, RabbitMQ, and Docker installer. It uses deterministic protocol fixtures for
inference engines and a browser-side Tauri IPC contract so the test never changes the developer's
Homebrew, Python, model, or LaunchAgent installation.

- Spec: `e2e/future/onboarding-ai-setup.spec.ts`
- Acceptance matrix: `e2e/future/FTUE_TEST_CASES.md`
- Engine fixture: `e2e/future/fixtures/inference-engine-server.ts`
- Hardware fixture: `e2e/future/fixtures/host_metrics.apple-silicon.json`
- Marketplace/Docker fixture: `e2e/future/fixtures/marketplace/`
- Infrastructure runner: `e2e/run-future-onboarding.sh`
- Run: `pnpm e2e:future:onboarding`

The lane covers Apple Silicon recommendations, mobile behavior, mlx-dspark and MTPLX automatic
runner setup, vLLM key/URL propagation, Lucebox discovery, Ollama pull/load/pin, a real queued
Docker install, and completion retry rules. The backend receives
`RABBITMQ_QUEUE_PREFIX=ftue-e2e`, which keeps its consumers from sharing jobs with a development Hub
connected to the same broker. Production queue names are unchanged when the variable is absent.
The runner preserves healthy PostgreSQL and RabbitMQ services, provisions them only when absent,
and tears them down only when it owns them. The FTUE catalog is copied per run so backend
normalization cannot mutate checked-in fixture files. Local defaults use dedicated FTUE ports, data
directory, and PostgreSQL database rather than sharing mutable application state with a running Hub.
The installer fixture uses a test-only app URN and Compose project to avoid colliding with the real
marketplace app represented by its FTUE row.

## CI coverage

| Workflow | Trigger | What runs |
|----------|---------|-----------|
| `ci.yml` | Every PR | lint, tsc, unit tests (not e2e) |
| `e2e.yml` | Release / manual | Default Playwright |
| `e2e-extended.yml` | Manual (or restored nightly / label triggers) | Cross-domain + future |
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

Fleet QA orchestration (private ops) lives in companionintelligence/CI-Engineering `tools/fleet-qa/` (issue #211) — inventories and multi-node runners are not in this tree.

## Agent notes

- App Explorer (`e2e/app-explorer.spec.ts`) is for marketplace QA — see FLYWHEEL.md
- Generated catalog tests: `e2e/generated/catalog-batch-*.spec.ts`
- Regenerate test inventory: `pnpm run agent:test-inventory`
