# Session Worksheet: catalog-row-checker

## Meta

| Field | Value |
|-------|-------|
| **Slug** | catalog-row-checker |
| **Date** | 2026-11-15 |
| **Agent** | Claude |
| **Model** | Sonnet 5.5 (implementation), Opus (independent review) |
| **Task** | The top-ranked follow-up of the 2026-11-15 curated-models refresh (PRs #2475 and #2476): add a deterministic checker that reads the registry data behind every LLM row of the curated catalog. |

## Goal

Replace the hours of per-row agent verification that the 2026-11-15 refresh needed with one read-only script. For every LLM row it reads the same primary data (registry manifests, config blobs, Hugging Face metadata), prints a table, exits nonzero when a row cannot be pulled, is missing or gated, or could not be read, and flags drift in rows that are already in the table.

## Steps taken

1. Read `CONTRIBUTING.md`, `AGENTS.md`, `docs/agent/AGENT_WORKFLOW.md`, and the refresh's worksheet. PR #2475 was still open when the session started, so the branch was based on its branch, `feat/catalog-refresh-tools`, to keep the `docs/MODEL_REGISTRY.md` steps in line. #2475 and #2476 both merged during the session, and the branch was then rebased onto `dev`; the only conflict was the feedback line in `docs/agent/WORKFLOW_FEEDBACK.md`, and both lines were kept.
2. Read the live registries with plain `GET`s to settle each response shape before writing code: Ollama manifests and config blobs (the blob answers with a redirect to presigned storage), Hugging Face's Ollama endpoint (HTTP 400 has two meanings, and a missing repo is a 401), the Hugging Face API (`gated`, and `original/` holding a second copy of gpt-oss's weights), and `config.json` files (`text_config` against `vision_config`, and a bare `Infinity`).
3. Moved the two User-Agents, the manifest `Accept` type, and the Ollama and Hugging Face reference parsing out of `gen-kv-geometry.ts` into `registry-endpoints.ts`, so the generator and the checker ask each registry the same way. Re-ran the generator on three rows: only the header line changed.
4. Wrote the checker in five modules under `scripts/catalog/` (reads, rules, row source, report, command), and recorded fixtures from the live registries for the tests.
5. Ran it over the whole catalog before writing the tests: 222 rows on the base in 21 seconds. That run found a bug in my reader (a `config.json` with a bare `Infinity`) and a case where summing only root-level `.safetensors` disagreed with a row's `gb` (Ornith's `optiq/` folder); both are fixed and tested.
6. Planted defects in the source one at a time, 51 against the first version. 49 were caught by the first suite; the two survivors (a config that names only `remote_host`, and a `gb` of zero) got tests.
7. Ran it over the catalog with #2476's rows in it, first on a scratch merge of the two open PRs and this branch, then on `dev` after the rebase: 255 LLM rows in 24 to 38 seconds across four runs, 424 read-only requests, and no row's result differed between the two. The full table is in the pull request description.
8. Added Step F to `docs/MODEL_REGISTRY.md`.
9. Had an independent reviewer on a different model read the code against the spec, then fixed what it found and planted 20 more defects (four the reviewer said the suite would miss, four against the Ornith finding, and twelve against the fixes).

## Decisions

| Decision | Rationale |
|----------|-----------|
| Read each row's authored `gb` from the catalog source text, not from `CURATED_MODELS`. | `withFileFootprint` replaces an Ollama row's size with its files' size, so the authored `gb` is gone once the module loads. A test checks the reader against the module for every oMLX and vLLM row (their `diskMb` is still `gb` x 1024), so a change to the table format fails a test. Exporting the tables from `curated-models.ts` would have put a change to production code in a tooling PR and into the file #2476 edits. |
| Compare `gb` as decimal GB, within 10% for Ollama and `hf.co` rows. | On the 107 library rows the median of fileBytes / (gb x 1e9) is 0.999, against 0.931 for GiB. |
| Sum only the `.safetensors` at a repo's root, and name the files outside it when a row's `gb` counted them. | vLLM and mlx-lm read the root shards. Summing everything doubles gpt-oss-20b (27.5 GB against the row's 13.8), while Ornith 1.5 35B's row counts its `optiq/` folder. Neither rule fits both rows, so the finding says which one the row follows. |
| Failures are unpullable, missing, gated, and cloud proxy; unread is a separate state that also exits 1; everything else warns. | The task named unpullable, missing, and gated as hard. A cloud row breaks the catalog's local-only rule. A row that could not be read must never look like a row that was read and found fine. `--strict` turns warnings into failures. |
| Keep the known `file_type` exceptions at the three the task named, and report the rest. | The first run reported 16 rows whose `file_type` is not their `q4_K_M` label: Q4_0 on nine, Q8_0 on four, MXFP4_MOE and NVFP4 on one each, and a config with no `file_type`. Adding them to the exception list would have hidden them. |
| No GGUF header reads. | Every specified check reads a manifest or a config blob. `gguf-header.ts` and `readHeader` stay with the generator, which needs them. The checker shares the endpoints, not the header reader. |
| Skip Lemonade rows and list them. | They name a key in the server's own `server_models.json`, which the script does not read. A test fails if a new backend appears that is neither routed nor skipped. |
| Store the one non-JSON fixture as `.txt`. | Biome cannot parse a `config.json` with a bare `Infinity`, and the test needs it byte for byte. |

## Files touched

- `scripts/catalog/registry-endpoints.ts` (new)
- `scripts/catalog/gen-kv-geometry.ts`
- `scripts/catalog/check-rows.ts` (new)
- `scripts/catalog/row-reads.ts` (new)
- `scripts/catalog/row-checks.ts` (new)
- `scripts/catalog/row-report.ts` (new)
- `scripts/catalog/row-source.ts` (new)
- `scripts/__tests__/catalog-row-checks.test.ts` (new)
- `scripts/__tests__/catalog-row-reads.test.ts` (new)
- `scripts/__tests__/catalog-check-rows.test.ts` (new)
- `scripts/__tests__/fixtures/catalog-rows/` (new: recorded answers, `replay.ts`, a README)
- `docs/MODEL_REGISTRY.md`
- `docs/agent/sessions/2026-11-15-catalog-row-checker.md`
- `docs/agent/sessions/2026-11-15-catalog-row-checker-feedback.md`
- `docs/agent/WORKFLOW_FEEDBACK.md`

## Tests run

- [x] `pnpm run lint:ci` — one error, in `packages/backend/build.ts` (a format error that `origin/dev` has too, in a file this branch does not touch). Biome reports nothing in the other 2,630 files.
- [x] `pnpm run tsc` — not applicable: it covers `packages/*`, and nothing type-checks `scripts/`. The new files and `gen-kv-geometry.ts` type-check under a throwaway tsconfig with the repo's compiler options and an alias for `@ci-hub/common/types`.
- [x] `pnpm run test:cli` — 146 files, 3,733 tests passed (7 skipped), among them the 126 new ones. Run on the final commit.
- [x] `pnpm run knip:ci` — passed.
- [x] The three new test files — 126 tests, offline.
- [x] 71 planted defects, one at a time — all 71 are caught (two survived the first suite and got tests).
- [x] Live runs — 10 rows, then the 222-row base catalog, then the 255-row merged catalog (24 to 38 seconds across four runs, 424 `GET`s: 242 to registry.ollama.ai, 182 to huggingface.co).
- [x] `gen-kv-geometry.ts --only` on three rows after the refactor — only the header line changed.
- [ ] App run (`pnpm run local`) — not applicable: a dev script, and nothing it reads is part of the app.
- [ ] `bin/agent-validate-shift` — not run as one command, because `lint:ci` fails on `origin/dev` itself. Its lint, test, and knip steps were run separately, as listed above.

## Open items / handoff

- The first run's findings are decisions for the Hub owners, and the pull request description lists every one. In short: `glm-5-2` and `inkling` fail (sharded); nine rows need an Ollama above the 0.34.0 pin; 16 rows are not the `q4_K_M` they are labelled; seven oMLX rows advertise more context than their repo's `config.json` allows; five rows' `gb` is more than the tolerance off.
- `FILE_TYPE_EXCEPTIONS` is deliberately the three rows the task named. When a row's mislabel is accepted, add it there with the reason.
- Not built, and worth a follow-up if the checker proves useful: a check of each row's `vision`, `tools`, and `reason` flags against the config blob's `capabilities`, a check of an MLX row's quant label against `config.json`'s `quantization`, and a baseline file so the command can run in CI without a red first run.
- The `isModelLoaded()` id question for oMLX rows from the refresh's handoff is untouched.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| wrap | domain and code-quality: false negatives, false positives, network safety, test quality, doc truth | Opus | Found no high-severity false negative and four medium issues, all fixed: a layer with no size counted as 0 bytes, an API record with no file list read as a repo with no weights, a repo with no weight file at all only warned, and no test covered a 5xx on `config.json`. Also fixed: a `null`, a list, or an odd-typed field crashed the whole run instead of making one row unread; duplicate ids in the catalog tables were accepted; a storage host's error body could be printed; `FILE_TYPE_EXCEPTIONS` could not cover `hf.co` rows; four defects the suite did not catch (a 500 treated as final, `-Infinity`, the 30-second wait boundary, the `config.json` retry); and two inaccurate sentences in Step F. Not taken: a warning for a renamed Hugging Face repo, because none of the 89 repos is reached through a redirect today. |
