# Coding Conventions — CI-Hub (Agents)

> **Purpose:** Conventions for review agents — beyond what Biome enforces automatically.
> **Scope:** TypeScript, Rust, tests, NestJS, React, Tauri patterns.
> **Linter:** Biome (`biome.json`) — run `pnpm run lint:ci` before finish.
> **Router:** [AGENTS.md](../../AGENTS.md)
> **Last updated:** 2026-07-12
> **Related:** .cursor/rules/ci-checks.mdc, docs/agent/TESTING.md

---

## TypeScript / JavaScript

### Biome-enforced (do not fight)

- No non-null assertions (`!`) — use explicit types or guards (`noNonNullAssertion`)
- 2-space indent, 150-char line width
- Use `pnpm` — never npm/yarn/bun for this repo

### Agent-specific

- **Vitest module mocks:** Use `vi.hoisted` + `vi.mock` at file top — `vi.spyOn` on imported modules does not intercept bindings already captured by the importing file
- **Mock typing:** Explicitly type stubs, e.g. `(configureClient?: boolean) => Promise<number | null>` — do not rely on `async () => null` inference
- **Fake timers:** Prefer `getByText` after `flushAsyncWork`; `findByText` hangs under `vi.useFakeTimers()`
- **Minimal scope:** Smallest correct diff; no drive-by refactors

---

## React / Frontend

- Hub status gate: API probe (`/api/health/live`) is UI truth — not Docker state alone
- Optional sidecars must not block steady-state UI or `all_ready`
- User reload in Tauri: `revalidate()` not `window.location.reload()`
- `isUserInitiatedPageReload()`: guard `performance.getEntriesByType` — may be missing in WebViews

---

## NestJS / Backend

- New endpoints need Swagger decorators (OpenAPI drift CI)
- Health: `/api/health/live` for liveness probes — match Docker healthcheck
- Queue work for long operations — don't block HTTP handlers

---

## Rust / Desktop

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

## Git / PR

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
