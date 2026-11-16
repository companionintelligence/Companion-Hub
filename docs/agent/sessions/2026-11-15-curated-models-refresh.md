# Session Worksheet: curated-models-refresh

## Meta

| Field | Value |
|-------|-------|
| **Slug** | curated-models-refresh |
| **Date** | 2026-11-15 |
| **Agent** | Claude |
| **Model** | Sonnet 5.5 (implementation), Opus 5.5 (wrap review) |
| **Task** | User request: update the curated model listing from ollama.com/search?o=newest, then also from huggingface.co/models and the Artificial Analysis open-weights leaderboard. |

## Goal

Refresh the Hub's curated model catalog from three public sources. Add a model only when its tag, size, quantization, and architecture are confirmed in primary data, and leave out anything Ollama cannot pull or the pinned llama.cpp cannot load. Keep the Artificial Analysis (AA) columns whole on one index version.

## Steps taken

1. Collected candidates from the first 140 of the 270 entries on Ollama's newest list (7 of 14 pages; the oldest entry on page 7 was last updated in November 2024), Hugging Face listings (GGUF, `mlx-community`, vLLM-servable repos), and the AA open-weights page.
2. Verified each candidate twice from raw data: registry manifests and config blobs, ranged GGUF header reads, and the Hugging Face API. A first pass proposed rows and a second, independent pass tried to refute them.
3. Added 16 Ollama, 12 oMLX, and 5 vLLM rows, generated geometry entries for the 16 Ollama rows (an `hf.co/` row is sized from Hugging Face's manifest, so a vision projector counts), added active-parameter entries for the mixture-of-experts rows (including the existing Ornith 1.0 35B, which had been treated as dense), and corrected the Ornith 1.5 capability flags.
4. Took Mistral Medium 3.5 off the fabrication guard after the registry manifest, the GGUF header, and the Hugging Face repo showed the model is real, and added a guard test for sharded Hugging Face GGUFs.
5. Wrote a recommendation sweep, ran it over 251 hardware profiles, and dropped one oMLX row that would have changed the default on a 32 GB Mac.
6. Split the work into two PRs on a fresh `origin/dev`: this one (catalog data) and one for the tooling and the procedure docs. Ran the local gate in separate worktrees, then planted 35 defects one at a time to check that the new tests notice them.
7. Ran the wrap review on a model other than the implementer: ten Opus 5.5 reviewers, with three skeptics checking each serious finding. 23 findings held up, among them a missing projector size, two wrong vision flags, two names wrongly called sharded-only, and several wrong or hollow claims in notes, docs, and tests. All were fixed.
8. Ran a second round with four reviewers on the fixes. 15 more findings held up: a bit-rate range that was still wrong, two more models with single-file builds, a test regex that missed Gemma 1, a stale test comment, a generator catch that was too broad, and stale wording in the commit messages. All were fixed.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Leave the AA columns on index v4.3 and give new rows no scores. | AA now publishes v5.0.1 and scores only 44 open-weights models, so a whole-column re-pull would blank most rows. A v5.0.1 number beside v4.3 ones would rank on mixed scales. |
| Do not add sharded Hugging Face GGUFs as `hf.co/` rows. | Hugging Face answers Ollama's registry request for them with HTTP 400, so the pull fails. |
| Keep Command A+ and Muse Spark Open out. | Their single-file builds exist only from individual re-quantizers that were not vetted (Command A+ is 132 GB, and Muse Spark Open is a Q4_0, not a Q4_K_M). |
| Leave the existing `glm-5-2` and `inkling` rows alone. | They fail the same pull check, but no hardware profile in the sweep ranks them in its top five, so bootstrap never installs them. Removing them is a decision for the Hub owners. |
| Leave the Laguna XS 2.1 oMLX row out. | Every oMLX row is unscored, so its 33B would have replaced DeepSeek R1 32B as the default on a 32 GB Mac. |
| Add the four rows that need a newer Ollama than the fleet pin. | The product has no Ollama version gate, and rows from 2026-11-08 already needed 0.40.x. Ollama's registry answers an older client with HTTP 412 at the manifest, so the pull fails before anything downloads. |
| Flag the two Ornith 1.0 oMLX rows as vision. | Their mlx-community repos carry a vision tower that the text-only Ollama builds lack. |
| Keep the sweep's tier rule as a simplified copy of the inspector's. | Calling `HardwareInspectorService.computeTier` needs `@ci-hub/common` built, which a fresh checkout does not have. |
| Open two PRs. | One logical change per PR: the data change can merge without the tooling and the other way round. |

## Files touched

- `packages/backend/src/modules/inference/catalog/curated-models.ts`
- `packages/backend/src/modules/inference/catalog/kv-geometry.generated.ts`
- `packages/backend/src/modules/inference/__tests__/curated-models.test.ts`
- `docs/inference-engine-comparison.md`
- `docs/agent/sessions/2026-11-15-curated-models-refresh.md`
- `docs/agent/sessions/2026-11-15-curated-models-refresh-feedback.md`
- `docs/agent/WORKFLOW_FEEDBACK.md`

The companion PR changes `scripts/catalog/gen-kv-geometry.ts`, adds `scripts/catalog/recommendation-sweep.ts`, and updates `docs/MODEL_REGISTRY.md`.

## Tests run

- [ ] `pnpm run lint:ci` — fails on `origin/dev` itself: one format error in `packages/backend/build.ts`, a file this change does not touch. `biome ci` passes on the changed TypeScript files.
- [x] `pnpm run tsc` — passed.
- [x] `pnpm --filter backend run test` — 495 files and 13,115 tests passed (2 skipped).
- [ ] `pnpm run test` — turbo stopped at the frontend test `mobile-app-metadata.test.ts`, which fails on `origin/dev` too (it expects the old iOS build number). The openclaw-plugin (44) and common (559) lanes passed, and the frontend lane had 4,127 passing tests and that one failure.
- [x] `pnpm run knip:ci` — passed.
- [x] `curated-models.test.ts` — 41 of 41 (33 before).
- [x] 35 planted defects, one at a time — 34 are caught: 33 fail the test written for them, and one (a header count that is too high) makes the module throw on import. The survivor is a wrong TOON `gb` on a row with a geometry entry, which the runtime ignores.
- [x] Recommendation comparison over 251 hardware profiles against `origin/dev` — 11 default changes, all at sizes nobody ships.
- [ ] App run (`pnpm run local`) — not run: the change is catalog data, and nothing was pulled or loaded.
- [ ] `bin/agent-validate-shift` — not run as one command, because it stops at `lint:ci` on `origin/dev`. Its lint, tsc, and test steps were run separately, as listed above.

## Open items / handoff

- `glm-5-2` and `inkling` probably cannot be pulled (sharded Hugging Face GGUFs). Remove them, or re-host each as one merged blob, once a pull is tried on a node.
- Four rows need a newer Ollama than the fleet's 0.34.0 pin: `ripple-preview-65b` (0.40.16), `lfm3-vl-2b` (0.40.13), `nemotron-3-5-super-120b` (0.40.5), and `lfm2-5-24b` (0.40.4). Fleet QA cannot run them until the pin moves.
- Nothing was pulled or loaded. One `/api/show` on a node would confirm the Granite 4.2 capability flags, which come from the GGUF chat template because the library page shows no badges.
- Older local models were checked once and left for a follow-up: `devstral-small-2:24b`, `devstral-2:123b`, `qwen3-next:80b`, `qwen3-coder-next`, `olmo-3.1:32b`, `rnj-1:8b`, `lfm2.5-thinking:1.2b`, and the Hugging Face-first GGUFs (Hy3, MiniCPM5, Mellum2.1, K2 Horizon). Command A+ and Muse Spark Open also need their re-quantizers vetted.
- IBM, Nanbeige, Nous Research, OpenBMB, and Ricursive have no brand mark in `icons.tsx`, so their rows show the generic cube.
- `flint:40b` (an existing row) is an NVFP4 build under its default tag, but its row carries the default q4_K_M label and has no `gpuVendors` gate. Settle that with the row.
- Eight new rows carry licenses with revenue or business-use limits (the five LFM rows, the two Qwen3.8 Flash-Next rows, and Mistral Medium 3.5). The catalog has no license field.
- A reviewer found an existing issue outside this diff, not checked further here: the Hub compares oMLX model ids in the `mlx-community/<repo>` form, while oMLX reports `<repo>` or `mlx-community--<repo>`, so `isModelLoaded()` may never match without an alias. It affects every oMLX row and needs a check on a Mac.
- `origin/dev` was red when this was built: `lint:ci` reports a format error in `packages/backend/build.ts`, and the frontend test `mobile-app-metadata.test.ts` expects the old iOS build number. Neither file is touched here.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| wrap | domain: claims audit (Ollama rows, oMLX and vLLM rows, header notes, docs, PR text) | Opus 5.5 | Six reviewers re-checked every row and claim against raw registry and Hugging Face data. Found Arete's size missing its projector, Command A+ and Muse Spark Open wrongly called sharded-only, the 140-of-270 page count, two Ornith 1.0 vision flags, and several wrong comments. All fixed. |
| wrap | code-quality | Opus 5.5 | Reviewed `--only` and the sweep. Led to the bare `--only`, CRLF, and header-date fixes. |
| wrap | security | Opus 5.5 | Found no secrets, private hostnames, pickles, or tag redirects. Three oMLX repos ship vendor-identical modeling code, and oMLX runs it only with `trust_remote_code` on. Found Ollama's Mistral Medium 3.5 build ships Mistral Small 4's system prompt and no license layer. |
| wrap | maintainability and ai-smells | Opus 5.5 | Found test names that claimed more than they asserted and unpinned oMLX and vLLM sizes (now asserted), a docs dependency on the other PR (removed), and a wrong pointer to the guard that holds granite4.1 and lfm2:24b. |
| wrap | writing style | Opus 5.5 | Fixed the wording it flagged in the docs, comments, and PR text. |
| wrap, round 2 | fix verification: data and facts, tests, tooling and docs, text and process | Opus 5.5 | Four reviewers re-checked every round-1 fix and the sentences the fixes added. Found 15 more problems (see step 8), all fixed. |
