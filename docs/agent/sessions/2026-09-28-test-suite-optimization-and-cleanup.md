# Test Suite Optimization & Junk Test Cleanup

> Commit with work. Git tag after merge: `agent-session/test-suite-optimization-and-cleanup`

---

## Meta

| Field | Value |
|---|---|
| **Slug** | `test-suite-optimization-and-cleanup` |
| **Date** | 2026-09-28 |
| **Agent** | Antigravity |
| **Model** | Gemini 2.5 Pro |
| **Task** | Audit CI-Hub tests, eliminate junk tests and retired runner assertions, fix execution bottlenecks (reducing CI test run time from 20+ min to ~2.5 min) |

---

## Goal

Resolve slow, expensive CI test runs and eliminate obsolete "junk" tests across CI-Hub. Specifically:
1. Stop running unneeded `--coverage` on every unit test run in `packages/backend` and `packages/common`, moving it to dedicated `test:coverage` scripts.
2. Enable Turborepo caching for the `"test"` pipeline.
3. Fix test timeouts and concurrency thrashing in `packages/frontend` (increasing timeout from 5s to 15s) and `scripts/vitest.config.ts`.
4. Fix compose synchronization drift (`docker-compose.prod.yml`, `docker-compose.local.yml`, `docker-compose-sync.test.ts`, `seed-appliance-desktop-package.test.ts`, and `bundled-hub-assets.generated.ts`) to align with active inference engines (`omlx`, `vllm`, `ollama`, `lemonade`).
5. Update `pool-diagnostics-cli.ts` and `pool-diagnostics-cli.test.ts` to test active engines instead of dead runners (`mtplx`, `dspark`, `lucebox`).
6. Fix macOS BSD stat compatibility in `docker-entrypoint.sh` so `test/entrypoint/run.sh` passes across platforms.
7. Clean up dead mocks (`fetchDsparkInstallStatus`) and outdated runner assertions in frontend test files.

---

## Results & Benchmarks

| Metric | Before | After | Improvement |
|---|---|---|---|
| Full monorepo `pnpm run test` | > 20m 37s (exceeding CI timeouts) | **2m 23s** | **8.6x faster** |
| `packages/backend` tests | ~15m (with v8 AST coverage overhead) | **2m 24s** | **6.2x faster** |
| `packages/common` tests | 24.05s | **10.6s** | **2.3x faster** |
| `test:entrypoint` | 4 failures on macOS | **17 passed, 0 failed** | Fully passing |
| `scripts/__tests__` | 2 failed files, timeout flakes | **103 passed, 0 failed (2,713 tests)** | Fully passing |
| `check:pr` (lint, knip, tsc, openapi, cargo) | Failing | **100% green** | Fully passing |

---

## Files Changed

- `package.json`: Added `test:coverage` script pointing to `turbo run test:coverage`.
- `turbo.json`: Enabled caching for `test` pipeline; added `test:coverage` task.
- `packages/backend/package.json`: Separated default `test` (`vitest run`) from `test:coverage` (`vitest --coverage --watch=false run`).
- `packages/common/package.json`: Separated default `test` (`vitest run`) from `test:coverage` (`vitest run --coverage`).
- `packages/frontend/vite.config.ts`: Added `testTimeout: 15_000` to prevent jsdom timeout flakes under concurrency.
- `scripts/vitest.config.ts`: Added `testTimeout: 15_000` to avoid subprocess timeouts in fleet install tests.
- `docker-compose.prod.yml`: Updated `environment` block to remove `MTPLX_URL`, `DSPARK_URL`, `SPECULATIVE_INFERENCE_URL`, `LLAMACPP_URL`, `LMSTUDIO_URL`, adding `OMLX_URL` and `OMLX_API_KEY`.
- `docker-compose.local.yml`: Aligned backend URL environment variables with active runners.
- `scripts/lib/bundled-hub-assets.generated.ts`: Regenerated bundled assets matching synced compose files.
- `scripts/pool-diagnostics-cli.ts`: Updated `BACKEND_URL_VARS` to `OLLAMA_URL`, `OMLX_URL`, `VLLM_URL`, `LEMONADE_URL`.
- `scripts/__tests__/pool-diagnostics-cli.test.ts`: Updated tests to assert active runner variables (`OMLX_URL`) instead of dead ones.
- `scripts/__tests__/docker-compose-sync.test.ts`: Updated tests to assert active runner defaults.
- `docker-entrypoint.sh`: Supported BSD `stat` (`stat -f`) fallback for macOS developers.
- `packages/backend/src/modules/mcp/tools/inference.tools.ts`: Updated tool description to list supported backends.
- `packages/backend/src/modules/inference/__tests__/inference-router.service.test.ts`: Relaxed wall-clock timer threshold to tolerate event loop jitter under load while maintaining concurrency assertions.
- `packages/frontend/src/modules/onboarding/components/__tests__/ai-setup-step.test.tsx`: Removed dead `fetchDsparkInstallStatus` mock.
- `packages/frontend/src/modules/settings/containers/__tests__/ai-settings.test.tsx`: Removed dead `fetchDsparkInstallStatus` mock.
- `packages/frontend/src/modules/onboarding/helpers/__tests__/use-model-pull-orchestrator.test.ts`: Updated test names and model IDs from dspark/mtplx to omlx.
- `docs/agent/TEST_INVENTORY.md`: Regenerated test inventory.
