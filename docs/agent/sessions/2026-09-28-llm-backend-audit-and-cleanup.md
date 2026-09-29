# LLM Backend & Curated Models Audit & Cleanup

> Commit with work. Git tag after merge: `agent-session/llm-backend-audit-and-cleanup`

---

## Meta

| Field | Value |
|---|---|
| **Slug** | `llm-backend-audit-and-cleanup` |
| **Date** | 2026-09-28 |
| **Agent** | Antigravity |
| **Model** | Gemini 2.5 Pro |
| **Task** | Audit LLM backend and curated model system; create support matrix; implement fixes across branches/PRs |

---

## Goal

Audit the LLM inference backend engine consolidation (from 9 engines to 4: Ollama, vLLM, oMLX, Lemonade) and proxy pooling architecture. Fix the tool-calling stripping bug on 400 errors, restore the `/v1/completions` FIM endpoint, purge dead desktop runner code, and align compose / turbo environment configuration.

---

## Steps taken

1. **Audit & Support Matrix**:
   - Researched local gateways (`InferenceRouterService`), cluster proxy pool (`HubPoolProxyService`), and engine adapters (`ollama`, `vllm`, `omlx`, `lemonade`).
   - Wrote comprehensive audit report and support matrix artifacts.
2. **PR 1: `fix(inference): restore /v1/completions and preserve tool error responses` (#1656 - Merged)**:
   - Eliminated silent tool-stripping retry on 400 errors in `InferenceRouterService.proxyToBackend`.
   - Restored `/v1/completions` routing in `InferenceController` and `InferenceRouterService.routeCompletion`.
   - Added adaptive prefill timeout estimation (`Math.max(120_000, Math.ceil(bodyBytes / 4 / 50) * 1000)`).
   - Added unit test suite in `inference-router.service.test.ts` (all 24 passed).
3. **PR 2: `refactor(desktop): delete dead inference runners and docker helpers` (#1658 - Open)**:
   - Deleted dead functions (`install_and_start_dspark`, `install_and_start_mtplx`, `install_and_start_lucebox`, `ensure_vllm_metal`).
   - Deleted unused constants and Docker management functions in `inference_runners.rs`.
   - Verified 13 unit tests pass cleanly in `cargo test --bin ci-os-hub-desktop inference_runners`.
4. **PR 3: `refactor(inference): align omlx compose env and purge dead runner references` (#1659 - Open)**:
   - Added `OMLX_URL` and `OMLX_API_KEY` to `docker-compose.prod.yml` and `turbo.json`; removed legacy `MTPLX_URL`, `DSPARK_URL`, `SPECULATIVE_INFERENCE_URL`, `LLAMACPP_URL`, `LMSTUDIO_URL`.
   - Removed dead model IDs from `ACTIVE_PARAMS_OVERRIDE` in `curated-models.ts`.
   - Deleted orphaned `managed-runner-auth.ts` and test.
   - Updated MCP inference tool description to 4 engines (`Ollama`, `vLLM`, `Lemonade`, and `oMLX`).

---

## Decisions

| Decision | Rationale |
|---|---|
| Preserve 400 backend errors with tools intact | Retrying without tools caused agent frameworks to enter infinite conversational loops instead of handling tool errors truthful to the OpenAI spec. |
| Restore `/v1/completions` | Editor tools like Continue.dev and Copilot bridges use FIM text completions supported natively by Ollama and vLLM. |
| Delete vestigial desktop runners | Retired engines (`dspark`, `mtplx`, `lucebox`) added dead code and maintenance burden to the desktop layer. |

---

## Files touched

- `packages/backend/src/modules/inference/inference-router.service.ts`
- `packages/backend/src/modules/inference/inference.controller.ts`
- `packages/backend/src/modules/inference/model-registry.service.ts`
- `packages/backend/src/modules/inference/supervision/backend-observer.service.ts`
- `packages/backend/src/modules/inference/__tests__/inference-router.service.test.ts`
- `packages/desktop/src-tauri/src/inference_runners.rs`
- `packages/desktop/src-tauri/resources/docker-compose.prod.yml`
- `turbo.json`
- `packages/backend/src/modules/inference/catalog/curated-models.ts`
- `packages/backend/src/modules/inference/app-credentials.service.ts`
- `packages/backend/src/modules/mcp/tools/inference.tools.ts`
- `packages/backend/src/modules/inference/managed-runner-auth.ts` (deleted)
- `packages/backend/src/modules/inference/__tests__/managed-runner-auth.test.ts` (deleted)
- `docs/agent/sessions/2026-09-28-llm-backend-audit-and-cleanup.md`

---

## Tests run

- [x] Backend inference unit tests (`pnpm --filter backend exec vitest run src/modules/inference/__tests__/inference-router.service.test.ts`)
- [x] Curated models & MCP tests (`curated-models.test.ts`, `app-credentials.service.test.ts`, `mcp.service.test.ts`)
- [x] TypeScript typecheck (`pnpm --filter backend exec tsc --noEmit`)
- [x] Desktop unit tests (`cargo test --bin ci-os-hub-desktop inference_runners`)
- [x] Biome formatting & lint check (`pnpm exec biome check ...`)
