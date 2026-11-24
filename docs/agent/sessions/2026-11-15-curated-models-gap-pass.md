# Session Worksheet: curated-models-gap-pass

## Meta

| Field | Value |
|-------|-------|
| **Slug** | curated-models-gap-pass |
| **Date** | 2026-11-15 |
| **Agent** | Claude |
| **Model** | Sonnet 5.5 (implementation), Opus (independent review) |
| **Task** | Add the local models that the 2026-11-15 curated-models refresh (PRs #2475 and #2476) checked once and left out, with a second verification pass, and vet Command A+ before deciding whether to list it. Started from another Claude Code session. |

## Goal

Add 21 rows to the curated catalog, reading every fact from raw registry data (manifests, config blobs, ranged GGUF headers, vendor cards) and not from library pages or summaries: Devstral Small 2 and Devstral 2, Qwen3-Next, Qwen3-Coder-Next, OLMo 3.1 32B, Rnj-1 8B, LFM 2.5 Thinking 1.2B, the five Qwen3-VL sizes, MiniCPM5 1B and 2B, five K2 Horizon sizes, Mellum 2.1, and Hy3. Decide whether Command A+ is listed. Move no recommended default.

## Steps taken

1. Read `CONTRIBUTING.md`, `AGENTS.md`, `docs/agent/AGENT_WORKFLOW.md`, `docs/MODEL_REGISTRY.md`, and the refresh's worksheet and feedback. #2475 and #2476 were still open, and the task allowed stacking, so the work started in a new worktree on `origin/dev` with both branches merged in. The shared checkout was not touched.
2. Read primary data for every candidate with plain `GET`s: Ollama manifests and config blobs (`file_type`, `requires`, `parser`, `renderer`, `capabilities`), Hugging Face's Ollama endpoint asked with an Ollama User-Agent (200 for a single file, 400 for a sharded repo), Hugging Face trees, ranged GGUF headers, vendor cards, and the llama.cpp architecture list at the Ollama tags that bundle it (0.34.0 has b10760, 0.40.4 b11521, 0.40.16 b12177). Two independent readers collected it.
3. Found vendor namespaces for two of the "Hugging Face first" families: `openbmb/minicpm5` and `openbmb/minicpm5-2b`, and `ifm/k2-horizon` with all five sizes. Their config blobs declare capabilities and a `requires` version that an `hf.co/` tag lacks, so they are listed from there. Mellum 2.1 and Hy3 stay `hf.co/` rows: each is a single-file build (HTTP 200 from Hugging Face's endpoint).
4. Tested the K2 Horizon template claim on Ollama 0.40.16 on this Mac with `ifm/k2-horizon:0.9b-q4_K_M` (666 MB, the only model pulled). A multi-turn chat whose assistant turn has no thinking field, `think` true and false, a system message, and a tool call with its result all answered 200. The raise ("Assistant message is missing a thinking field") is in bartowski's GGUF templates only; IFM's repos and registry builds carry a different template. The same model layer through `hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M` chats the same but reports tools and completion only, so `think: true` answers HTTP 400.
5. Vetted Command A+ (`coder543/command-a-plus-05-2026-gguf`, the only single-file build found) from its manifest, tree, and header, without downloading the 132 GB file. Kept it out; the dated note gives the reasons.
6. Wrote the 21 rows and their active-parameter entries, and generated the KV geometry with `gen-kv-geometry.ts --only`. That exposed two tool bugs. For Hy3 the tool took the first file whose name contains the quant, the 81-block `Hy3-Q4_K_M-mtp.gguf`, where Hugging Face serves the plain 80-block file. For Qwen3-Next it counted all 48 blocks as cached, because llama.cpp defaults `full_attention_interval` to 4 when the key is absent, and the registry's file has none (12 cached). Fixed both; moved the file selection into a pure module (`gguf-files.ts`) with tests built from real repo trees; and made an `hf.co/` row stop when the size of the file it read differs from the model layer the manifest serves. The third review round added two more: the shards of a split quant are the files named exactly `<prefix>-NNNNN-of-<count>.gguf` (a sibling set with the same prefix and count was being summed in), and a refusal from Hugging Face's endpoint stops the row unless it is the 400 that says the repo is sharded (a quant the repo does not list answers 400 as well).
7. Replayed every llama.cpp checkpoint in Lemonade's current registry (GitHub main: 98, of which 41 name a quant and 57 a file, the 39 behind the catalog's Lemonade rows among them) through the old and the new selection, with each entry's own `mmproj`: same files and byte totals in all 98, so no existing generated entry moves. My first replay covered only 19 by-quant checkpoints of the catalog's rows, and the commit message said "the 19", which the third review round caught.
8. Took each row's `reason`, `vision`, and `tools` from what the build offers through Ollama, read from Ollama v0.34.0's source (config `capabilities` and `parser`, then the Go template, then the GGUF chat template), and not from the library badges. Three rows differ from their pages: `olmo-3.1:32b` (the Think build has no tools), Hy3 (no thinking flag), and both MiniCPM5 builds (tools and thinking, from a GGUF template that Ollama prefers).
9. Pinned every new row, its geometry, and the notes' checkable claims in `curated-models.test.ts`; updated the counts (146 Ollama rows, 276 LLMs); wrote the dated notes; and updated Steps A, B, and C of `docs/MODEL_REGISTRY.md`.
10. Ran the recommendation sweep over 251 hardware profiles: no default changes.
11. Reviewed four times by an independent Opus reviewer given the code and the task, not my conclusions (the last two on the final tree, and then on the fixes the third prompted), and planted 86 defects one at a time against the new tests (see Reviews run).
12. #2475, #2476, and #2477 (the row checker) merged while this ran, so the branch was rebased onto `origin/dev`, dropping the merge of the two stacked branches. One conflict: #2477 had moved the `hf.co/` parsing in `gen-kv-geometry.ts` into `registry-endpoints.ts`, on the lines my guard replaced; I kept its helpers and my body. `check-rows.ts` now exists, so I ran it: the 21 rows give 16 ok, 5 warn (the K2 `requires` above the pin), and no failure; the whole catalog gives 276 LLM rows, 194 ok, 39 warn, 2 fail (`glm-5-2` and `inkling`, left alone as the task says), 0 unread, 41 skipped. A fourth PR, #2478 (the oMLX model-id fix), landed after the reviews and edited the same test file's imports, so I rebased once more; the one conflict was that import block, and I kept both sides' imports.

## Decisions

| Decision | Rationale |
|----------|-----------|
| List MiniCPM5 and K2 Horizon from the vendors' own Ollama namespaces, not `hf.co/`. | The config blob declares `capabilities` and `requires`. On Ollama 0.40.16 the `hf.co/` route of the same K2 blob lost thinking (HTTP 400 for `think: true`), because Ollama selected the GGUF's template. |
| List K2 Horizon although it needs Ollama 0.40.4, above the fleet's 0.34.0 pin. | The task allows it if the dated note names it. The note does, and `check-rows.ts` flags all five (`requires`). Moving the pin, or gating by version, is the Hub owners' decision. |
| K2 Horizon by explicit `-q4_K_M` tags. | The default tags of the 0.9B and 3.7B are Q8_0. |
| Flags from the build's capabilities, not the library badges. | The pool routes a request that asks for tools or thinking by these flags and passes over a build whose flag is 0, and Ollama refuses `think` for a build without it. A flag that claims more sends requests to a refusal. |
| `gb` is the sum of every manifest layer, in decimal GB to one decimal. | It is what the pull downloads and what `/api/tags` reports, and what `kv-geometry.generated.ts` charges. |
| Devstral Small 2 carries 256K and LFM 2.5 Thinking 32K. | Those are the vendors' stated windows. The library pages say 384K and 125K, and the files hold 393,216 and 128,000. |
| Active parameters for the MoE rows are the vendors' figures. | The estimate from the GGUFs' expert counts lands within about 1B of each; the K2 MoVA tensors give about 6B with the embedding and output tables and 4.7B without them, so its row says 4 as the vendor card does and the comment gives both. |
| Keep Command A+ out. | The only single-file Q4_K_M is one personal account's re-quantization (223 downloads), whose header has no quantizer or base-model fields, so Step A's provenance rule cannot be met from the file; its weights cannot be checked without 132 GB, its context length (200,000) differs from the vendor's 128K, and it has no vision projector. |
| Leave `olmo-3-7b` and `olmo-3-32b` as they are. | Their flags say tools and no thinking, the opposite of their `olmo3-think` builds, but they are older rows outside this task. Named in the note as a follow-up. |
| Move the file selection into a tested module and add the size guard. | A wrong pick of a sibling file is silent: the header reads fine and the geometry is plausible. The guard turns it into a stopped row. |

## Files touched

- `packages/backend/src/modules/inference/catalog/curated-models.ts`
- `packages/backend/src/modules/inference/catalog/kv-geometry.generated.ts`
- `packages/backend/src/modules/inference/__tests__/curated-models.test.ts`
- `scripts/catalog/gguf-files.ts` (new)
- `scripts/catalog/gen-kv-geometry.ts`
- `scripts/catalog/gguf-header.ts`
- `scripts/__tests__/gguf-files.test.ts` (new)
- `scripts/__tests__/gguf-header.test.ts`
- `docs/MODEL_REGISTRY.md`
- `docs/agent/sessions/2026-11-15-curated-models-gap-pass.md`
- `docs/agent/sessions/2026-11-15-curated-models-gap-pass-feedback.md`
- `docs/agent/WORKFLOW_FEEDBACK.md`

## Tests run

All on the final commit, after the last rebase onto `origin/dev` (6c4164e44).

- [x] `pnpm run lint:ci` — one error, the format of `packages/backend/build.ts`, which `origin/dev` has too and this branch does not touch. Biome reports nothing in the other 2,638 files.
- [x] `pnpm run tsc` — passed.
- [x] `pnpm run knip:ci` — passed.
- [x] `pnpm --filter backend run test`, on its own — 496 files and 13,198 tests passed (1 file and 2 tests skipped). That includes `curated-models.test.ts` at 47 tests: 7 new, and the count test updated.
- [x] `pnpm run test:cli` — 147 files, 3,759 tests passed (7 skipped). That includes 25 new tests in `gguf-files.test.ts` and one in `gguf-header.test.ts`.
- [x] `pnpm --filter frontend run test` — 295 files and 4,144 tests passed; one test fails: `mobile-app-metadata.test.ts` ("agrees across tauri.conf, iOS project.yml, iOS Info.plist, and Android" got an iOS bundle version of 20261115 and expected 0.1.1). It reads mobile version files, and no file of this branch is one of them. (That run is from before the last fixes, none of which touches the frontend.)
- [x] `recommendation-sweep.ts` on the 21 ids — 251 profiles, 0 default changes, 8 other top-5 lists change below their first pick.
- [x] `check-rows.ts` — the 21 rows: 16 ok, 5 warn, 0 fail. The whole catalog: 194 ok, 39 warn, 2 fail (the known `glm-5-2` and `inkling`).
- [x] 86 planted defects, one at a time, in a scratch worktree, on the final code: 84 caught, 2 survived, and both survivors are redundant end anchors (the `$` of `pickQuantFile`'s pattern and of the shard collector's, which the `.gguf` filter on the candidates already enforces; they differ only for a name that contains `.gguf` twice). The first suite let some through (a changed tier, purpose, and `gb`), which are now pinned.
- [x] Lemonade replay — all 98 llama.cpp checkpoints of the current registry (41 by quant and 57 by file name, the 39 behind the catalog's Lemonade rows among them) pick the same file and bytes under the old and new rules, each with its registry `mmproj`.
- [x] Live Ollama run — K2 Horizon 0.9B only, on 0.40.16 (see step 4). No other row was pulled or loaded.
- [ ] App run (`pnpm run local`) — not applicable: catalog data, a generator script, and docs.
- [ ] `bin/agent-validate-shift` — not run as one command, because `lint:ci` fails on `origin/dev` itself. Its lint, tsc, knip, and test steps were run separately, as listed.

## Open items / handoff

- The five K2 Horizon rows cannot be pulled by a fleet on Ollama 0.34.0 (`requires` 0.40.4). Move the pin, or gate the rows by version, as for the nine rows `check-rows.ts` already flags.
- The older `olmo-3-7b` and `olmo-3-32b` rows have the opposite flags from their `olmo3-think` builds (tools, no thinking).
- Nothing but K2 Horizon 0.9B was run. A fleet smoke test of the small new rows would settle the template-dependent flags (the MiniCPM5 pair report tools and thinking from a GGUF template that Ollama prefers, and the 2B's stop list is one string holding a JSON array). Fleet writes need the user's go-ahead.
- Two local test models remain on this Mac's Ollama: `ollama rm ifm/k2-horizon:0.9b-q4_K_M hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M`.
- Two licenses carry revenue limits (Devstral 2: no rights above $20M monthly revenue; LFM 2.5 Thinking: $10M annual). The catalog has no license field, so the dated note says so.
- No brand mark exists for IFM, JetBrains, Tencent, or Essential AI.
- Still unvetted: Muse Spark Open, GLM 5.3 Flash, and MiMo-V2.6 Flash (single-file builds from individual re-quantizers), and `laguna-xs.2`, `minicpm-v4.5:8b`, and `minicpm-v4.6:1b`.
- `check-rows.ts` does not compare `reason`, `vision`, and `tools` with the config blob's `capabilities`. Five rows (the three here and the two OLMo 3 rows) differ from their library badges, so that check would have paid off.
- `recommendation-sweep.ts` ranks picks by text; a reviewer suggested adding vision picks.
- Nothing unit-tests `HttpError` or its use in `huggingFaceLayers` (`gen-kv-geometry.ts` runs `main()` on import, so a test cannot load it). The decision it makes, `isShardedRefusal`, is tested, and the wiring was run live on ten rows, the sharded `glm-5-2` and `inkling` among them, with an unchanged generated file.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| rounds 1 and 2 | domain and code-quality: rows, notes, flags, docs, tooling, tests | Opus | Each round got the code and the task, not my conclusions, and re-read raw registry data. Together they found factual errors that my own checks had passed: `olmo-3.1:32b` had been given tools, Hy3 a thinking flag (and the purpose reasoning), and MiniCPM5 flags that did not match its GGUF template; the note on K2's template said one bartowski repo raises where five do, and counted IFM's repos as four where there are five; the MoVA active-parameter wording; the doc's capability-derivation rules; the Command A+ rationale; "tensors" where the files count parameters; and many sentences in the notes and tests that said more than was checked. Two tool bugs came out of the same reads (the `-mtp` pick and the `qwen3next` interval). The suite also let tier, purpose, and `gb` changes through, which led to the pinning above. |
| final | same brief, on the final tree after the rebase | Opus | Found no wrong row value: it re-read every tag, `file_type`, `requires`, layer sum, `fileBytes`, geometry value, flag, parser, template, card, and license against primary data and agreed. It found five things, each fixed or, where the tool still differs from llama.cpp, stated in a comment: the capability rule in the docs and the note left out parts of Ollama v0.34.0's source (a `parser` or `renderer` makes Ollama skip the GGUF's chat template, the config's `capabilities` are always added, the thinking test also takes a split of `content` at `</think>`, the GGUF template wins only under a tool-round-trip condition, and vision is `<arch>.vision.block_count`); `selectGguf` summed in a sibling shard set with the same prefix and count; a quant that Hugging Face's endpoint does not list (also HTTP 400) fell back to the tree like a sharded repo; a header test locked in a result that llama.cpp would not compute for a per-layer array without zeros, and llama.cpp reads `attention.recurrent_layers` first; and the first commit message's "19 checkpoints" was a subset of 98. It also asked whether any K2 row, which needs Ollama 0.40.4, reaches a top-5 list (none does: the eight changed lists are all `qwen3-next-80b` entering fifth place), and noted that the note said nothing of the 256-versus-262 window rows or of the MiniCPM5 2B's `num_ctx` 4096 (now stated). What it could not check from primary data is my own runs (K2 0.9B on Ollama 0.40.16, the sweep, "two independent readers") and the MiniCPM5 library-page badges. |
| fix delta | same brief, on the uncommitted fixes that the final round prompted | Opus | Confirmed the sweep sentence, the nine rows whose files hold 262,144 tokens, the MiniCPM5 2B `num_ctx`, the Go templates, the Hugging Face statuses, the new shard regex and `isShardedRefusal`, and that my replay script's copy of the old function matches `origin/dev`. It found that my rewritten capability text still said a parser build ignores its Go template layer (it does not: that template's `.Tools` and `.Thinking` are added, as with `devstral-2`), said "offers more" for what Ollama counts, left out `OLLAMA_GO_TEMPLATE` and `<SPECIAL_12>`, and said a build with no Go template layer is judged by the GGUF's chat template without the parser exception; and that the K2 note stated HTTP 412 as observed when it comes from Ollama's issue tracker (the registry answers an `ollama/` client 401). All reworded from the source. It also remarked that the new array test in `gguf-header.test.ts` passes whichever way the array and the interval interact, and that the `mtp/` directory test guards only the shard regex's start anchor: the code comment no longer claims the array wins, and the second is a regression guard, as its title says. |
