# Session Worksheet — FTUE full integration

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `ftue-full-integration` |
| **Date** | 2026-09-05 |
| **Agent** | Codex |
| **Model** | GPT-5 |
| **Task** | Add detailed FTUE frontend integration coverage for Docker installers and local LLM inference engines |

## Goal

Exercise the real first-time setup UI against the backend, PostgreSQL, RabbitMQ, Docker app
installer, and deterministic inference-engine services. Cover desktop and mobile behavior,
backend selection and recovery, model installation, app installation, preference persistence,
and completion retries without modifying the user's running Hub or native model services.

## Steps taken

1. Audited the existing onboarding, inference, marketplace, and Playwright boundaries and mapped the complete FTUE surface.
2. Added isolated inference and marketplace fixtures while retaining real frontend, backend, database, queue, and Docker execution.
3. Implemented ten browser acceptance scenarios and documented the broader 52-case release matrix.
4. Fixed dspark model selection after runner discovery and namespaced test queues so a live Hub cannot consume FTUE jobs.
5. Added a focused infrastructure runner and isolated the writable marketplace catalog per run.
6. Ran focused unit/type checks and the complete isolated FTUE integration lane.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Base the follow-up on current `dev` | PRs #1204 and #1229 are merged, so the test PR no longer needs to remain stacked. |
| Use real backend, PostgreSQL, RabbitMQ, and Docker boundaries | Validate persisted choices and installer jobs instead of replacing the behavior under test with route mocks. |
| Use deterministic HTTP fixtures for inference engines | Exercise browser/backend protocols, streaming, auth, recovery, and model management without large downloads or host-service mutation. |
| Mock only the Tauri command bridge in browser tests | Validate desktop orchestration while keeping LaunchAgent and Homebrew mutation in the native release-smoke lane. |
| Prefix RabbitMQ queues in the isolated lane | Prevent another local Hub backend from consuming test app-install jobs. Production queue names remain unchanged by default. |

## Files touched

- `e2e/future/onboarding-ai-setup.spec.ts` and `e2e/future/fixtures/`
- `e2e/future/FTUE_TEST_CASES.md`
- `playwright.future-onboarding.config.ts`, `e2e/start-backend.sh`, and `e2e/fixtures/fixtures.ts`
- `e2e/run-future-onboarding.sh`, `e2e/pre-test-cleanup.sh`, and `e2e/helpers/ensure-test-database.ts`
- `packages/frontend/src/modules/onboarding/components/ai-setup-step.tsx` and its focused tests
- `packages/backend/src/modules/queue/queue.module.ts` and its focused tests
- `docs/system/backend.md`, `docs/system/e2e.md`, `e2e/README.md`, and the generated test inventory

## Tests run

- [x] Targeted Biome checks and `git diff --check`
- [x] Backend and frontend type checks
- [x] 61 focused onboarding frontend tests
- [x] 2 queue-name isolation tests
- [x] 10 full-stack FTUE Playwright scenarios, including a real Docker installation
- [x] App run through the isolated frontend/backend integration stack
- [x] Full typecheck, unit suite (5,169 passed; 2 expected skips), and OpenAPI drift check
- [ ] `bin/agent-validate-shift --skip-visual --skip-benchmark` — stops on an unrelated `origin/dev` Biome error in `packages/mobile/src-tauri/tauri.conf.json`; this branch does not change that file, and every remaining gate passed independently

## Open items / handoff

- The automated browser lane intentionally does not install Homebrew packages, create a real macOS LaunchAgent, or download multi-gigabyte models.
- Run the documented native Apple Silicon smoke cases before release to validate those host-mutating boundaries.
- Lemonade remains hidden on macOS by product policy; its cross-platform FTUE lane is documented as a follow-up.
- Additional failure, accessibility, and browser-engine cases are detailed in `e2e/future/FTUE_TEST_CASES.md`.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| Research | Maintainability | Codex | Mapped state ownership and retained real service boundaries where deterministic and safe. |
| Plan | Maintainability | Codex | Split protocol fixtures from product assertions and isolated all mutable resources. |
| Implementation | Security + maintainability | Codex | Checked synthetic credentials, exact Docker cleanup, queue isolation, recovery behavior, and production defaults. |
| Wrap | Security + code quality | Codex | Fixed writable-catalog mutation, Docker project collisions, complete labeled-resource cleanup, and partial-infrastructure ownership; confirmed source fixtures and live Hub services remain untouched. Full gate is blocked only by the unchanged upstream mobile Tauri formatting error. |
