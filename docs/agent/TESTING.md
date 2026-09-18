# Testing guide

> **Purpose:** How to write and run unit, integration, and E2E tests in Hub.
> **Scope:** Vitest (packages), Playwright (E2E), integration tests, visual regression.
> **Inventory:** [TEST_INVENTORY.md](TEST_INVENTORY.md) — regenerate with `pnpm run agent:test-inventory`
> **Commands:** `pnpm test`, `pnpm run test:e2e:ci`, `pnpm run test:visual`
> **Router:** [AGENTS.md](../../AGENTS.md)
> **Last updated:** 2026-07-12
> **Related:** docs/system/e2e.md, .cursor/rules/ci-checks.mdc

---

## Test layers

| Layer | Tool | Location | CI |
|-------|------|----------|-----|
| Unit | Vitest | `packages/*/**/*.test.ts(x)`, `scripts/__tests__/` | `ci.yml` |
| CLI binary smoke | Vitest + bun | `scripts/__tests__/cli-binary-smoke.test.ts` | `cli-binary-tests.yml`, `ci.yml` |
| Integration | Vitest + Docker | `packages/backend/test/integration/` | `integration-tests.yml` |
| E2E | Playwright | `e2e/**/*.spec.ts` | Release / manual / labels |
| Visual | Playwright + pixelmatch | `e2e/visual/` | `agent-gates.yml` |
| Benchmark | `benchmark-app.ts` | `e2e/results/benchmarks/` | `agent-gates.yml` |

**Why the CLI has its own layer:** `cihub` ships as a bun-compiled single-file binary, and every
other gate looks at the TypeScript instead. v0.2.67 shipped a `cihub pool update` that died on
`ReferenceError: colorize is not defined` with tsc, Biome and 1000+ unit tests green. The smoke
suite compiles the binary with the release's own `scripts/build-standalone-cli.cjs` and runs its
commands against stub `docker`/`git` binaries and a throwaway `HOME` — no real Docker state, no
network. Add a case there whenever you add a CLI subcommand. It skips locally without bun and
**fails** without bun when `CI` is set, so it can never pass by not running.

---

## Writing unit tests

### Frontend (Vitest + Testing Library)

```bash
cd packages/frontend && pnpm test -- src/path/to/file.test.tsx
```

**Do:**
- Mock Tauri via `window.__TAURI_INTERNALS__.invoke`
- Mock module imports with `vi.hoisted` + `vi.mock` (not `vi.spyOn` on already-imported modules)
- Use `vi.useFakeTimers()` + `getByText` after `flushAsyncWork` — avoid `findByText` with fake timers
- Explicitly type mock stubs: `(configureClient?: boolean) => Promise<number | null>`

**Don't:**
- Use non-null assertions (`!`) — Biome `noNonNullAssertion` fails CI
- Assert implementation details over user-visible behavior
- Leave `fetch` stubs that always return ok when testing unhealthy → healthy transitions

### Backend (Vitest)

```bash
cd packages/backend && pnpm test -- src/path/to/file.spec.ts
```

**Do:**
- Mock Drizzle/queue dependencies at module boundary
- Test error paths and validation in addition to the happy path

### Desktop (Rust)

```bash
cd packages/desktop/src-tauri && cargo test
```

---

## Writing E2E tests

See [e2e/README.md](../../e2e/README.md) for lanes and local setup.

**Do:**
- Use existing helpers in `e2e/helpers/`
- Tag slow tests appropriately
- Write targeted specs for the flow you changed

**iOS and phone Hub (not XCUITest):** CI does not run the Simulator. Vitest catches WKWebView white screens in `packages/frontend/src/lib/ios-navigation.smoke.test.tsx` (page slides, body scroll lock, and inline theme lock). Add a case there when you add a route or overlay. Playwright `e2e/navigation.spec.ts` covers desktop Chromium only.

**Don't:**
- Use App Explorer for general Hub feature validation (marketplace QA only)
- Rely on screenshot file-size heuristics — use `e2e/helpers/screenshot.ts` or Playwright `toHaveScreenshot`

---

## Visual regression

```bash
pnpm run test:visual
```

1. Baselines live in `e2e/screenshots/baselines/`
2. Failed runs write actual + diff to gitignored dirs
3. Update baselines intentionally when UI changes are correct — see `.claude/skills/visual-regression/SKILL.md` (mirrored at `.cursor/skills/`)

---

## False-confidence tests

Periodically audit with `.claude/skills/test-audit/SKILL.md` (mirrored at `.cursor/skills/`):

- Tests that mock the thing they claim to test
- Assertions that can never fail
- Tests that don't match their `it('...')` description

---

## Scoped CI before PR

```bash
pnpm run lint:ci
pnpm run tsc
pnpm test
bin/agent-validate-shift
```

See [END_OF_SHIFT.md](END_OF_SHIFT.md).
