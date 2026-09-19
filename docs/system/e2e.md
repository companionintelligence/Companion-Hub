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

| Workflow | Trigger **as committed** | Intended trigger | What runs |
|----------|---------|---------|-----------|
| `ci.yml` | Every PR | same | lint, tsc, unit tests (not e2e) |
| `e2e.yml` | `workflow_dispatch` + `workflow_call` | nightly 01:00 UTC | Default Playwright |
| `e2e-extended.yml` | `workflow_dispatch` | nightly 03:00 UTC + PR label | Cross-domain + future |
| `e2e-mcp.yml` | `workflow_dispatch` | same, by design | MCP connect recipe — protocol handshake + app env injection (12 tests) |
| `agent-gates.yml` | `workflow_dispatch`, `continue-on-error: true` | PR (optional) | Visual + benchmark gates |
| `nightly-release.yml` | `workflow_dispatch` | nightly 00:00 UTC | calls `e2e.yml` |

**No e2e lane currently runs on its own.** `e2e.yml`, `e2e-extended.yml` and `nightly-release.yml` each keep their
real triggers in a `# >>> ci-local:gated` comment block at the top of the file, restored with `ci-local restore`.
That gating is deliberate cost control, not rot — but the effect is that a change which breaks the authenticated
lane produces no signal at all until someone dispatches a run by hand. The `if:` guards inside `e2e-extended.yml`
still test for `schedule` and `pull_request` events that can no longer arrive.

Run them by hand:

```bash
gh workflow run e2e.yml --ref <branch>
```

## The fixture contract

`e2e/fixtures/fixtures.ts` seeds an operator straight into Postgres and then drives the real login form. Three
things about that path are load-bearing, and each one silently killed every authenticated spec when it drifted:

- **`clearDatabase()` deletes children before parents** (`e2e/helpers/db.ts`). The list is hand-maintained, and it
  runs in the `page` fixture before *every* test — so a new table with a non-cascading FK to `user`, `app`,
  `app_store` or `device_registration` fails at setup, not in the test body. `federated_identity.user_id` has no
  `onDelete`, so it must be deleted first; `api_key.created_by_user_id` cascades and needs no entry.
- **`createTestUser()` must set `localPasswordSetAt`.** `loginWithCachedPassword` rejects a user without it as
  invalid credentials *before* it verifies the hash, because null means "this account has no offline password".
- **The mock portal must answer `POST /api/whois`.** Hub login is Portal-backed: `AuthService.login` signs in
  against Portal first and only falls back to the local password when Portal is *unreachable*. `admitHubPerson`
  then resolves organisation membership through WhoIs and treats "could not ask" as a three-state `unknown`, which
  denies with `503 AUTH_ERROR_ORG_CHECK_UNAVAILABLE`. The route's `organizationId` has to match the registration
  `seedOrganization()` writes, or membership resolves to `not-member` — which *revokes* the seeded operator.

`e2e-mcp.yml` is dispatch-only on purpose: it boots a backend, so it earns its runner minutes only
when the MCP surface, its auth, or the connect docs change. Run it with
`gh workflow run e2e-mcp.yml --ref <branch>`, or `pnpm e2e:mcp` locally for the full 18-test lane
including the Docker-heavy install layer.

## Visual regression

- Specs: `e2e/visual/`
- Baselines: `e2e/screenshots/baselines/` — tracked in git, but **none are committed yet** (the
  directory holds only `.gitkeep`), so the gate cannot currently fail. `agent-gates.yml` skips
  `test:visual` when the directory is empty; the spec now skips with the same explanation when a
  baseline is missing, rather than failing on `compare()`'s `mismatchedPixels: -1`.
- **Seed baselines on Linux, not on a Mac.** `agent-gates.yml` is `runs-on: ubuntu-latest`, and
  Chromium's font rasterization differs enough between macOS and Linux to diff well past the 0.02–0.03
  thresholds on text-heavy screens. A macOS-generated baseline turns a decorative gate into a
  permanently red one, which is worse than no gate. `e2e.yml` seeds them on its own runner:

  ```bash
  gh workflow run e2e.yml --ref <branch> -f seed_visual_baselines=true
  gh run download <run-id> -n visual-baselines -D e2e/screenshots/baselines/
  git add e2e/screenshots/baselines/*.png
  ```

  The run writes `e2e/screenshots/baselines/` with `UPDATE_VISUAL_BASELINES=1` after the e2e suite
  and uploads it as the `visual-baselines` artifact. A Linux box with Docker can do the same with
  `pnpm run test:visual:update`.
- **`agent-gates.yml` cannot run `test:visual` as written.** The job installs dependencies and nothing
  else: no Postgres, no RabbitMQ, no `playwright install`. The spec drives the real login form against
  the real backend, so once baselines exist that step will fail on the missing stack, not on a diff.
  Give it the `services:` and Playwright steps from `e2e.yml` — or move the comparison into `e2e.yml`
  behind a step of its own — before committing baselines.
- Actual/diff: `e2e/screenshots/actual/`, `diff/` (gitignored)
- Helper: `e2e/helpers/screenshot.ts` (pixelmatch)
- Run: `pnpm run test:visual`
- Coverage if seeded: 2 screens (login, dashboard), one viewport, one theme.

## Documentation screenshots

Separate from visual regression, and for humans rather than diffing:

- Spec: `e2e/screens/capture-screens.spec.ts` (excluded from the default lane — it writes into the repo)
- Config: `playwright.screens.config.ts`
- Output: `docs/images/screens/<screen>-<theme>[-mobile].png`
- Run: `pnpm run docs:screens`

The spec carries a `SKIPPED` map naming every screen no fixture can reach and why, and it fails unless
the number of PNGs *that run wrote* is exactly what the screen lists imply — it counts its own writes, not
the directory, which always holds the last committed set. A silent shortfall would otherwise read as full
coverage. See `docs/system/ui-screens.md`.

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
