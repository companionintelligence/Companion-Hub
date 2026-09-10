# Coding conventions

> **Purpose:** Conventions for review agents — beyond what Biome enforces automatically.
> **Scope:** TypeScript, Rust, tests, NestJS, React, Tauri patterns.
> **Linter:** Biome (`biome.json`) — run `pnpm run lint:ci` before finish.
> **Router:** [AGENTS.md](../../AGENTS.md)
> **Last updated:** 2026-07-12
> **Related:** .cursor/rules/ci-checks.mdc, docs/agent/TESTING.md

---

## TypeScript and JavaScript

### Enforced by Biome

- No non-null assertions (`!`) — use explicit types or guards (`noNonNullAssertion`)
- 2-space indent, 150-char line width
- Use `pnpm` — never npm/yarn/bun for this repo
- **`scripts/**` only:** `correctness/noUndeclaredVariables` is an error. `biome.json` cannot carry
  comments, so the reason lives here: root `scripts/` is not in the pnpm workspace, so
  `pnpm run tsc` (which is `turbo run tsc`, `packages/*` only) never type-checks the shipped `cihub`
  CLI. A missing import or a `catch (_e)` body that reads `e` therefore compiles cleanly into the
  binary and becomes a `ReferenceError` the first time that line runs — which is exactly how
  v0.2.67 shipped a `cihub pool update` that crashed before doing any work. This rule is the static
  half of that guard; `scripts/__tests__/cli-binary-smoke.test.ts` is the runtime half.

### Agent-specific

- **Vitest module mocks:** Use `vi.hoisted` + `vi.mock` at file top — `vi.spyOn` on imported modules does not intercept bindings already captured by the importing file
- **Mock typing:** Explicitly type stubs, e.g. `(configureClient?: boolean) => Promise<number | null>` — do not rely on `async () => null` inference
- **Fake timers:** Prefer `getByText` after `flushAsyncWork`; `findByText` hangs under `vi.useFakeTimers()`
- **Minimal scope:** Keep the diff as small as possible, and avoid unrelated refactoring

---

## React and frontend

- Hub status gate: API probe (`/api/health/live`) is UI truth — not Docker state alone
- Optional sidecars must not block steady-state UI or `all_ready`
- User reload in Tauri: `revalidate()` not `window.location.reload()`
- `isUserInitiatedPageReload()`: guard `performance.getEntriesByType` — may be missing in WebViews

---

## NestJS and backend

- New endpoints need Swagger decorators (OpenAPI drift CI)
- Health: `/api/health/live` for liveness probes — match Docker healthcheck
- Queue work for long operations — don't block HTTP handlers

---

## Rust and desktop

- Optional sidecars: only `Ready` or `Unavailable` — never `Starting`/`Failed` for optional services
- Optional sidecars must not block `all_ready`
- Pair Rust unit tests with `hub-status.test.tsx` for status behavior

---

## Tests

- Test names must match what is asserted
- Don't mock away the behavior under test
- Prefer user-visible outcomes (Testing Library) over implementation details
- Add tests when fixing bugs — especially for hub-status and reload paths

---

## Git and pull requests

- Imperative commit messages, ≤ 72 chars
- One logical change per PR
- Never destructive git without user confirmation
- Commit session worksheet with code changes

---

## What belongs in Biome vs this doc

| Concern | Where |
|---------|-------|
| Formatting, import order | Biome |
| `!` assertions | Biome |
| Hub status business rules | This doc + system docs |
| Test mock patterns | This doc + TESTING.md |
| Architecture boundaries | docs/system/*.md |

When a convention repeats in review, consider adding a Biome rule or `.cursor/rules/` entry.
