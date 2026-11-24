import type {
  CuratedModel,
  HardwareTier,
  HostPlatform,
  InferenceBackendType,
  ModelModality,
  ModelPurpose,
  TierRecommendation,
} from '@ci-hub/common/types';
import { FIXED_RUNNER_OVERHEAD_MB } from '../model-geometry.util';
import { GGUF_KV_GEOMETRY } from './kv-geometry.generated';

// ─── LLM catalog (TOON) ──────────────────────────────────────────────────────
// The LLM catalog is authored as a TOON table (https://toonformat.dev) — one compact, pipe-delimited
// row per model. Every family + size is verified to exist on ollama.com/library (checked 2026-05, rows
// from `laguna-xs-2-1` through `medgemma1-5-thinking` added 2026-07-27, whole table re-audited and
// corrected 2026-07-27 — see PR description for the full audit writeup and its caveats) and the catalog
// lists only the bare `model:size` default tag (the guaranteed-pullable q4_K_M build), with documented
// exceptions: rows whose backendModelId carries a `namespace/model:tag` shape (e.g.
// `gabegoodhart/minimax-m2`, `bjoernb/gemma4-26b-think`, `jordimurgo/medgemma1.5-thinking`) pull a
// community quant/fine-tune from an individual publisher rather than the official library — quality and
// provenance are that publisher's, not vetted the way official-library rows are; and rows like
// `nanbeige4-3-33b` and `arete-27b`, which have no ollama.com/library listing, pull a single-file GGUF
// repack directly from Hugging Face via Ollama's `hf.co/{repo}:{quant}` pull syntax
// (`ollama pull hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M`). That syntax fails for a sharded repo:
// `inkling` and `glm-5-2` were added this way and probably cannot be pulled (see the first 2026-11-15 note).
//
// LOCAL ONLY: this catalog must never contain an ollama `:cloud`-tagged backendModelId. Those proxy
// inference through Ollama Cloud's own API rather than running on the user's hardware, which breaks the
// hardware-fit recommender (a cloud row's nominal "size" trivially "fits" any budget, so it can silently
// win every "best local model for this box" comparison — see `isCloudProxyModel` in
// model-registry.service.ts, added after this exact bug surfaced during the 2026-07-27 audit below). If a
// model is only available as `:cloud` on Ollama, either find a real single-file local GGUF (the pattern
// `arete-27b` uses, through `hf.co/bartowski/NousResearch_Arete-27B-GGUF`) or leave it out of the catalog rather
// than adding the cloud tag.
//
// KNOWN LIMITATION (2026-07-27 audit): the 2026-07-27 audit pass caught the session's own web-research
// tools fabricating convincing, internally-consistent pages for at least two model names this codebase's
// test suite already knows are fake (see `curated-models.test.ts`'s fabrication guard) — and, separately,
// one candidate row's fetched description self-referenced an Anthropic-internal codename it had no
// legitimate way to know, a strong contamination signal. Nine speculative rows added without a direct user
// request (`kimi-k3-cloud`, `granite4-1-3b/8b/30b`, `glm-5-1-cloud`, `minimax-m3-cloud`, `lfm2-24b`,
// `qwen3-fable-4b/8b`) were removed as a result — see the fabrication guard test for the full list. The
// remaining rows from that date (`laguna-*`, `ornith-*`, `lfm2-5-8b`, `north-mini-code-1-0`, `inkling`,
// `gemma4-26b-think`, `medgemma1-5-thinking`) came from URLs a human directly supplied rather than from
// the agent's own web search, which is a materially different trust basis, but they went through the same
// unreliable fetch tooling for their field-level details (sizes, context, capability flags) and have NOT
// been confirmed via an independent channel (a real browser, or an actual `ollama pull`). Treat them as
// provisional until someone does that out-of-band check.
//
// 2026-08-12: added Muse Glimmer (Meta), the Phi-4 family (Microsoft), Ministral 3 (Mistral), Command-R
// / Command-A (Cohere), OLMo 3 (Allen Institute), GLM-4.7-Flash (Z AI), Nemotron 3.5 Lightning (NVIDIA),
// and DeepSeek V4 Flash 0731 via a community re-host (`frob/deepseek-v4-flash-0731` — DeepSeek's own
// Ollama tag is cloud-only). Learning the lesson from the 2026-07-27 incident above, every one of these
// was adversarially re-verified through channels independent of this session's own ollama.com/
// artificialanalysis.ai fetches (official vendor sites/blogs, HuggingFace org pages, arXiv papers,
// independent press) before being kept. One entry did NOT survive that check and was removed: "Mistral
// Medium 3.5" — the exact model this file's own fabrication guard had already flagged as fake — which
// had slipped back in under a dashed catalog id (`mistral-medium-3-5-128b`) whose actual pull tag
// (`mistral-medium-3.5:128b`) was still the literal banned string; the id-only guard didn't catch it, so
// it now also checks `backendModelId`. See `curated-models.test.ts` for both.
//
// 2026-08-14: added Qwen 3.8 27B (`qwen3-8-27b`) from a user-supplied ollama.com/library/qwen3.8 URL.
// Verified via a real browser render of the library page and its /tags subpage (not this session's
// WebFetch summarizer, per the 2026-07-27 fabrication lesson above) — 8k+ downloads, "updated 3 hours
// ago", single `27b` size at 18GB / 256K context with vision+tools+thinking flags. No Artificial Analysis
// leaderboard entry exists yet for a model this new, so `intel`/perf columns are left blank.
//
// 2026-08-24: added the VLLM_MLX_LLM_TOON table below (6 rows) for vLLM-Metal — Apple Silicon Macs
// now have a real vLLM path via the MLX compute backend (github.com/vllm-project/vllm-metal), and
// Ollama 0.19 (preview, March 2026) separately gained a native MLX backend for the existing Ollama
// catalog above, so no catalog change was needed on that side — the same `family:size` tags apply,
// Ollama itself decides MLX vs. llama.cpp per host. Every MLX row's HuggingFace repo id and on-disk
// size were checked live via the Hugging Face Hub API (hub_repo_search + hf_fs), not web search
// summaries, per the fabrication lesson above.
//
// 2026-08-29: five ollama.com/library URLs supplied directly by a human were checked. Per the
// fabrication lesson above, verification used a real browser render of each library page and its
// /tags subpage, not this session's WebFetch summarizer. `glm-5.3` and `glm-5.3-flash` are real but
// `:cloud`-only (no local tag exists for either) — excluded per the LOCAL ONLY rule above, not added.
// `nemotron-3.5-lightning` was already in the catalog (added 2026-08-12) — nothing to do. `ornith-1.5`
// (creator: Deep Reinforce, same family as `ornith-9b`/`ornith-35b`) added as three new rows —
// `ornith-1-5-9b`/`-35b`/`-397b` — with real default tags; unlike the 1.0 rows, its library page shows
// no `tools`/`thinking` capability badge (only `vision`), so those flags were left unset rather than
// copied from the older sibling rows. `qwen3.8-flash-next` (Alibaba, billed as an early preview of the
// architecture behind Qwen4) is real but was NOT added: its only tags are Apple-MLX/NVIDIA-NVFP4
// (`125b-mlx`, `125b-a6b-nvfp4`, `125b-a6b-mlx-bf16`) — there is no bare GGUF default build, which
// breaks this table's `quantization === 'q4_K_M'` invariant (see curated-models.test.ts) and would also
// need a per-row Apple/NVIDIA-only `gpuVendors` gate the shared CATALOG_TOON → `generatedLlms` mapping
// has no mechanism for. Needs a deliberate schema decision (new `quant` column + gate, or its own small
// table like VLLM_MLX_LLM_TOON), not a same-shape row — left out pending that.
//
// 2026-09-09: reconciled against what the test tailnet is ACTUALLY running (12 reachable Hub nodes,
// 32 distinct installed tags). Provenance here is the strongest kind this file can have and needs no
// browser render: every field below was read back from the serving engine's own `/api/show` on a node
// that has the model resident, so it describes the build the fleet is running rather than a library
// page describing a build it might pull. Two rows added:
//   `qwen3-vl:32b`  — resident on 3 nodes; engine reports 33.4B / Q4_K_M / 262144 ctx and capabilities
//                     [completion, vision, tools, thinking]. The catalog had no Qwen3-VL row at all.
//   `gemma3n:e4b`   — resident on 1 node; engine reports 6.9B / Q4_K_M / 32768 ctx. Note the engine
//                     reports capabilities [completion] ONLY, so vision/tools are left 0 despite Gemma
//                     3n being marketed as multimodal — this table records what the running build does.
// Four more installed tags were deliberately NOT added: `llama3.2:latest` is an alias for the existing
// `llama3.2:3b` row (a tag-resolution matter, not a missing model), `qwen2.5:0.5b` is superseded by the
// catalogued `qwen3:0.6b`, and `llava:latest` / `moondream:latest` are legacy Q4_0 vision builds
// (moondream's context is 2048) long superseded by the gemma3 and qwen3-vl rows. All four live on one
// node — the fleet's scratch box — which is what an ad-hoc pull looks like, not a fleet standard.
//
// 2026-09-29: `intel`/`tps`/`ttft`/`e2e` re-pulled for every Ollama row, whole column together as the
// 2026-09-16 note below requires. Same index scale (Qwen 3.8 27B xhigh 33.9 → 33.7), but AA re-scored
// some models since — mostly ones it marks estimated: gemma4-31b 15.4 → 19.0, qwen3-8b/14b/32b 5.2/6.4/7.2
// → 7.3/8.2/8.6, llama4 Scout/Maverick 6.5/9.3 → 8.1/10.0, qwen3-5-9b 13.7 → 11.2; 21 scores moved, the
// speed columns drift with AA's rolling medians. Source: the `models` array embedded in the open-weights
// leaderboard page itself (684 records), fields `intelligenceIndex`, `medianOutputTokensPerSecond`,
// `medianTimeToFirstTokenSeconds`, `medianEndToEndResponseTimeSeconds` (a field AA leaves as the string
// "$undefined" is blank here). Mapping rule and every judgment call below are unchanged; effort variants
// are reasoning EFFORT, not context — `qwen3-8-27b` takes AA's canonical xhigh (33.7) over low 26.2 /
// medium 27.6 / non-reasoning 20.2. The same 24 rows stay blank. Added `gemma4-12b` (`gemma4:12b`, the
// q4_K_M build: 7.6 GB, 256K, text + image per ollama.com/library/gemma4/tags), scored from AA "Gemma 4
// 12B (Reasoning)" like the rest of the family; `gemma4-12b-lemonade` now inherits it.
//
// 2026-09-30: the three gemma4 rows the fleet has run carry a measured `ramGb`, because their download
// is no measure of what the engine holds. Each figure is what the engine process held, less
// the KV cache and compute buffers its own load log reports: the Hub charges KV per token of the window
// it loads, and compute buffers, which grow with the window, fall inside the estimate's fixed safety
// margin. What is left is weights, encoders and the runtime, and it does not move with the window.
// Read with Ollama 0.34.0 (llama-server): nvidia-smi or rocm-smi for the process on a discrete card,
// its DRM fdinfo on a unified-memory APU. `/api/ps` cannot be used: Ollama sums llama-server's "buffer
// size" log lines keyed by component, device and kind, so gemma4's second KV cache and second encoder
// buffer overwrite the first, and the encoder weights are never logged. beta-red's `/api/ps` said
// 3,209 MiB for e4b while nvidia-smi held 5,550.
//   gemma4:e4b  4,357 MiB, the largest of four readings: core-2 and beta-max (Strix Halo, Vulkan) 4,356
//               and 4,357 at 65536 tokens x 4 slots, beta-1 (RX 7900 XTX, ROCm) 4,260 and beta-red
//               (RTX 3080, CUDA) 4,046 at 16384 x 4. beta-red: 5,550 less 1,184 of KV and 320 of
//               compute. Of the 9,163 MiB file, llama.cpp leaves the 5,376 MiB per-layer embedding
//               table memory-mapped on the host and puts 2,830 MiB of weights on the card, plus the
//               vision and audio encoders; unified memory also holds the 525 MiB token table.
//   gemma4:26b  18,773 MiB. beta-max: DRM 21,246 less 1,920 of KV and 553 of compute, 4096 x 4. That
//               includes 1,020 MiB of host-side embedding buffers a discrete card keeps in system RAM.
//   gemma4:31b  19,646 MiB. beta-1: rocm-smi 28,393 less 7,680 of KV and 1,067 of compute, 4096 x 4,
//               split over both cards, so a second card's runtime is in it.
// 26b and 31b were made resident for this with one 1-token generation at num_ctx 4096. What the GPU
// held for the process, KV and compute included, stayed inside what the Hub charges for each window
// (footprint, KV at the geometry's per-token cost, the 1,024 MB margin and the vision reserve) on all
// four e4b nodes. None of these figures holds llama-server's prompt cache, which it keeps in host RAM
// (up to 8 GiB by default; core-2's e4b process had 8,490 MiB of RssAnon): on unified memory that
// comes out of the same pool, on top of the footprint (docs/MODEL_REGISTRY.md, "Measured
// footprints"). core-7 runs e4b on the CPU, where RSS holds that cache too, so it is not a reading of
// the weights. `gb` stays the download. Still derived from `gb`, because no node has them to measure:
// gemma4-12b, the MTP and community 26B rows, and every Lemonade and MLX gemma4 row.
//   gemma4-e2b stays derived too, although it looks like the same case as e4b. It is downloaded on
// core-6, core-17 and beta-3-glass but resident on none, so there is no process to read. Its load logs
// (core-6, core-17) put 1,397.5 MiB of weights on the card against e4b's 2,829.7, with the same
// encoders, which suggests about 2,925 MiB; but that is e4b's reading less a difference, not a
// reading. The row decides what a small card auto-installs, too: at 2,925 it became index 0 on 4 GB
// discrete cards in place of nemotron-3-nano-4b, a 7.2 GB download instead of 2.8 GB, which the load
// estimate then refuses on that card (4,977 MB at 4096 by the catalog alone, against 3,584). Fill it
// in once a node has held it.
//
// 2026-09-16: two changes, both mechanical and both re-derivable.
//
// (a) `intel`/`tps`/`ttft`/`e2e` re-pulled for every Ollama row from the Artificial Analysis open-weights
// leaderboard as it stood on 2026-09-16 — Intelligence Index **v4.3**, which is a different scale from
// the numbers this table carried before (v4.3 rebased hard: qwen3-6-27b 37.1 → 21.9, gpt-oss-120b 24 →
// 12.3, glm-5-2 51 → 34). The old values were left over from at least two earlier index versions, and a
// mixed-scale column is worse than a blank one, because `compareLlmCandidates` ranks on `intel` across
// rows. So the whole column moved together; do not patch single rows from a later leaderboard without
// re-pulling all of them. Source: the model records embedded in any artificialanalysis.ai/models/<slug>
// page (the leaderboard table page only renders a subset of columns) — fields `intelligenceIndex`,
// `timescaleData.medianOutputSpeed`, `timescaleData.medianTimeToFirstChunk`,
// `endToEndResponseTime.total`. Mapping rule: the AA entry whose reasoning mode matches the row's
// `reason` flag, and AA's own canonical slug where a model has effort variants (`qwen3-8-27b` = xhigh,
// `gpt-oss-120b` = high, `glm-5-2` = max). Values AA itself marks estimated (`intelligenceIndexIsEstimated`,
// shown with `*` on the site) are included — they are AA's numbers, not ours; 51 of the 76 refreshed rows
// are in that state, mostly deprecated-on-AA models. Judgment calls in the mapping, recorded so they can be
// overturned: `deepseek-r1-8b` → AA "DeepSeek R1 0528 Qwen3 8B" (Ollama re-pointed that tag in May 2025);
// `mistral-small-24b` → "Mistral Small 3"; `mistral-large-123b` → "Mistral Large 2 (Nov '24)";
// `devstral-24b` → "Devstral Small (Jul '25)". Left blank because AA has no entry (or only an ambiguous
// one): nemotron3-33b, deepseek-r1-7b, deepseek-coder-v2-*, mistral-nemo-12b, glm4-9b, laguna-*,
// ornith-*, gemma4-26b-think, medgemma1-5-thinking, phi4-reasoning-14b, command-r-35b (AA lists only the
// Mar '24 build; Ollama's tag was refreshed in Aug '24), olmo-3-32b (Think vs 3.1 Instruct), codestral-22b,
// deepcoder-*, qwen2-5-coder-1-5b/3b/14b. The `agentic` column (the old AA
// "Agentic Index", added 2026-05-30) was DROPPED the same day: v4.3 publishes no such composite any more
// (its records carry tau2/tau-banking/terminal-bench components, and no single one covers both old and
// new models), the values were a never-refreshed May snapshot, and nothing ranked on them.
//
// (b) Four `(MTP)` rows — the official ollama.com multi-token-prediction builds of models already in this
// table: `qwen3.6:27b-mtp-q4_K_M`, `qwen3.6:35b-a3b-mtp-q4_K_M`, `qwen3.8:27b-mtp-q4_K_M`,
// `gemma4:26b-a4b-it-mtp-q4_K_M`. These are the SAME q4_K_M weights plus the model's trained MTP head
// (`nextn_predict_layers = 1`), which Ollama's llama-server uses for self-speculative decoding
// (`--spec-type draft-mtp`); rejection sampling keeps the output distribution identical, so the
// leaderboard columns are inherited from the base row on purpose — unlike the MTPLX rows further down,
// which are third-party re-quantized checkpoints and stay blank. They are separate rows (not a hidden
// substitution) so the user sees exactly which build they are running; the recommender's quant-suffix
// collapse does not fold `-mtp` ids, so base and MTP can both surface. Measured 2026-09-16 on an RX 7900
// XTX (ROCm, Ollama 0.34.1, single stream): qwen3.6:27b decode 36 → 47 tok/s, qwen3.8:27b 36 → 47 tok/s
// on JSON image descriptions and 36 → 44 on prose chat (draft depth 3; the qwen3.8 tag's own default of 4
// measured slower on this card, 43/38). The two MoE rows were NOT measured — an already-fast 3B-active
// model has less to gain and the fixed draft cost is a larger share of its step. Needs Ollama ≥ 0.30.8
// (`OLLAMA_SPEC_MIN_VERSION` in eval/driver-conformance.ts); an older build loads the tag and silently
// runs at base speed. The variant is 0.4 GB larger on disk and allocates rollback checkpoints at runtime,
// so a card where the base only just fits can be pushed into partial offload — the `gb` column is the
// ollama.com figure for the MTP tag, not the base. The two Qwen 27B tags were verified by an actual
// `ollama pull` + benchmark; the 35B and Gemma tags only via the library page.
//
// Columns:
//   id              catalog id (`${family}-${size}`)
//   backendModelId  the exact ollama pull tag (`family:size`)
//   name            display name
//   purpose         general | coding | reasoning
//   params          parameter count in billions (best-fit ranking + CPU size cap)
//   gb              real default (q4_K_M) on-disk size in GB — requirements are anchored to this
//   tier            lowest hardware tier the size is surfaced as a default recommendation for
//   ctxK            context window in thousands of tokens (blank → default 128K)
//   creator         model creator / lab
//   intel           Artificial Analysis Intelligence Index (blank when not on the leaderboard)
//   reason          1 = reasoning model
//   vision          1 = accepts image input
//   tools           1 = supports tool / function calling
//   audio           1 = accepts audio/speech input
//   tps             AA median output tokens/sec (cloud reference; blank when unknown)
//   ttft            AA median latency to first chunk, seconds (cloud reference)
//   e2e             AA median end-to-end response time, seconds (cloud reference)
//   ramGb           optional: memory the model holds once loaded, less its KV cache and compute buffers,
//                   in GB, measured on a running engine (see the 2026-09-30 note). Replaces `gb` for the
//                   memory footprint and requirements, not for disk. Leave it blank unless measured.
//
// `intel`, `tps`, `ttft`, `e2e` are Artificial Analysis open-weights leaderboard figures (artificialanalysis.ai;
// most re-verified 2026-07-27, a few pre-2026-05 rows left as unconfirmed where independent re-fetches gave
// conflicting numbers — see PR description); perf numbers are AA's cloud-hosted measurements and are
// indicative only — real local speed depends on the user's hardware and quantization. Note: AA's Intelligence
// Index scores dropped noticeably across almost every re-checked model between the 2026-05 and 2026-07-27
// passes (e.g. gpt-oss-120b 33.3→24, llama-3.3-70b 14.5→9) — consistent with AA having rebased/recalibrated
// the index in between, not with the older numbers being wrong at the time they were entered.
//
// 2026-11-08: four new local Ollama tags verified by rendering their official library /tags pages in a
// real browser: mimo-v2.6:9b, flint:40b, nemotron-3.5-bolt:e4b, and lfm3:1.7b. Sizes and context below
// are the listed Q4_K_M/default builds; no Artificial Analysis entries were found, so scores stay blank.
//
// 2026-11-15: 16 rows from ollama.com/search?o=newest (the first 140 of its 270 entries, 7 of 14 pages; the oldest
// entry on page 7 was last updated in November 2024), Hugging Face, and the Artificial Analysis (AA) open-weights
// page. Every field came from raw data
// (registry.ollama.ai manifests and config blobs, ranged GGUF header reads, the Hugging Face API), and a second,
// independent pass re-derived each row. No weights were pulled or loaded, so none of these rows has run end to end.
//   - `qwen3.8-flash-next:125b-a6b-q4_K_M` reverses the 2026-08-29 verdict above. The family has no bare default,
//     but this tag is a plain llama.cpp GGUF (arch `qwen4exp`, `file_type` Q4_K_M, 120 GB), so it needs neither a
//     quant column nor a `gpuVendors` gate. Its MLX and NVFP4 tags stay out.
//   - Mistral Medium 3.5 is listed again. The 2026-07-27 and 2026-08-12 notes removed it as unconfirmed, but the
//     registry manifest (80.24 GB, `file_type` Q4_K_M, no cloud tag), the GGUF header (arch `mistral3`, 88 blocks,
//     context_length 262144) and the Hugging Face repo (created 2026-03-31, public history from 2026-04-29) all
//     predate those notes, so the fetch tooling failed, not the model. Its guard entries are gone from
//     curated-models.test.ts. Ollama's build has two quirks: a system prompt copied from Mistral Small 4 (a chat
//     with no system message is told it is Mistral Small 4) and no license layer (the vendor's
//     license, a modified MIT, grants no rights above $20M in monthly revenue). `granite4.1` and `lfm2:24b`, on the
//     2026-07-27 guard, are real too but superseded by granite4.2 and lfm2.5:24b, so they stay there.
//   - Outside the library: `frob/mistral-small-4:119b` (a merged single-blob re-host from the publisher of
//     `frob/deepseek-v4-flash-0731`; Mistral Small 4 has no library page), `openbmb/minicpm-v4.7:35b-a3b` and
//     `:1b` (the vendor's own namespace), and two single-file Hugging Face GGUFs through `hf.co/` (bartowski's
//     Q4_K_M): `nanbeige4-3-33b` and `arete-27b`. `Ricursive` (Ripple, from Ricursive Intelligence) and `Recursive`
//     (Flint) are two companies, spelled so on their library pages.
//   - Flags follow the library badges (the second pass below takes them from the build's own capabilities instead, and
//     did not recheck these rows). The `hf.co/` and `frob/` rows follow the vendor card, and `granite4.2`, whose
//     page shows no badges at all, follows its GGUF chat template (one `/api/show` on a node would confirm). The
//     Ornith 1.5 page now shows vision, tools, and thinking, so its 9B/35B/397B flags are flipped; the 397B is a MoE
//     (`qwen35moe`, 512 experts, 10 used, about 17B active) that the active-parameter map below used to call dense.
//   - Ollama's registry answers a client older than a build's `requires` field with HTTP 412 ("requires a newer
//     version of Ollama"). ripple-preview needs 0.40.16, lfm3-vl 0.40.13, nemotron-3.5-super 0.40.5, and lfm2.5:24b
//     0.40.4, all above the fleet's pin (`scripts/lib/fleet-ollama-version.ts`, 0.34.0), as flint, nemotron-3.5-bolt,
//     lfm3, and mimo-v2.6 already were. qwen3.8-flash-next needs 0.33.3, which the pin covers.
//   - `flint:40b` (added 2026-11-08) is an NVFP4 build under its default tag, yet its row carries the default
//     q4_K_M label and has no `gpuVendors` gate, which the 2026-08-29 note asks of NVFP4 rows. This pass leaves it.
// Real models left out:
//   - Sharded Q4-class repos on Hugging Face, which Ollama cannot pull: `ollama pull hf.co/<repo>:<quant>` asks
//     Hugging Face's registry endpoint, which answers HTTP 400 "This repository only contains sharded GGUF files" to
//     Ollama's User-Agent (single-file repos answer 200). Seen 2026-11-15 for Kimi K2.7 Code, MiMo-V2.6 Pro, Beam
//     1.0, Nemotron 3 Ultra, Ling 3.1 Flash, K2 Horizon 375B, GLM 5.3, and MiniMax M3. The same 400 came back for
//     this table's own `glm-5-2` and `inkling` rows, which may not install as written (`inkling`'s GGUF arch is
//     not in llama.cpp b12257 either).
//   - Muse Spark Open (466 GB Q4_0), GLM 5.3 Flash (193 GB Q4_K_M), and MiMo-V2.6 Flash (169 GB MXFP4) have
//     single-file builds, but only from individual re-quantizers (Interchained, vcruz305, and kernelpool, in that
//     order) that this pass did not vet. Command A+, the fourth, was vetted in the second pass below.
//   - Archs that the llama.cpp in Ollama's latest release and main cannot load (v0.40.16 has b12177 and main b12257;
//     the fleet's 0.34.0 has b10760): Inkling 2 Small (arch `inkling2`, upstream support is b12406), MiniMax-M3.1-Flash
//     (indexer tensors the loader never creates), DeepSeek V4.1 Flash 1017 (its Q4 build stores the engram table as
//     MXFP8, which that llama.cpp reads as plain F8_E4M3) and Step 5 Preview (no `step5` arch, no GGUF from a trusted
//     publisher).
//   - Over the 600 GB limit this pass used (just above `inkling`, the largest row at 587 GB): Kimi K3 and K3.1 Pro
//     (about 1.5 TB) and Mistral Large 4 (605 GB).
//   - Families whose bare default is not Q4_K_M: `bonsai-2` (ternary Q2_0), `cogito-2.1` (F16) and
//     `nemotron-3.5-bolt:74b-a9b` (IQ2_XXS). `lfm3-omni` and `lfm3-audio` list no audio in their tags page's Input
//     column. Cloud-only pages, `decision` classifiers, and embedding, TTS, and OCR families are out by the rules above.
//   - Local models older than this pass, checked once and left for a follow-up: laguna-xs.2, minicpm-v4.5:8b and
//     v4.6:1b. The rest of that list (devstral-small-2:24b, devstral-2:123b, qwen3-next:80b, qwen3-coder-next,
//     olmo-3.1:32b, rnj-1:8b, lfm2.5-thinking:1.2b, the other qwen3-vl sizes, Hy3, MiniCPM5 1B and 2B, Mellum 2.1, and
//     K2 Horizon 0.9B to 36B) went in with the second pass below.
//
// 2026-11-15, second pass: 21 rows for the older local models that the pass above left out. Each was read from raw data
// twice, by two independent readers of the registry manifest, the config blob, and the GGUF header (or, for `hf.co/`
// rows, Hugging Face's Ollama manifest and the file's header), and checked against the vendor's card. The recommendation
// sweep (251 profiles) moves no default and changes eight top-5 lists below their first pick: all eight put qwen3-next-80b
// fifth on a 54 to 72 GB machine, in place of qwen3-6-27b, and no other new row reaches a top-5 list. Only K2 Horizon
// 0.9B was run (below); no other row has been pulled or loaded.
//   - From Ollama's library: devstral-small-2:24b, devstral-2:123b, qwen3-next:80b, qwen3-coder-next, olmo-3.1:32b,
//     rnj-1:8b, lfm2.5-thinking:1.2b, and the qwen3-vl 2b, 4b, 8b, 30b, and 235b tags. Every manifest answers 200 with
//     `file_type` Q4_K_M, and the only `requires` fields among them (lfm2.5-thinking 0.14.3, qwen3-coder-next 0.15.5,
//     qwen3-vl 4b and 8b 0.30.0) are under the fleet's pin. `qwen3-coder-next` has no size tag, so the row names its
//     `q4_K_M` tag, which is what `latest` points at. The tags these rows name (`qwen3-next:80b`, `olmo-3.1:32b`, and
//     the qwen3-vl size tags) are the thinking builds. Devstral 2's Ollama template defaults its system prompt to "You
//     are Ministral-3-123B-Instruct-2512" (a chat with no system message is told it is Ministral 3), and neither
//     Devstral build on Ollama has a license layer.
//   - Flags follow what the build offers through Ollama 0.34.0 (the fleet's pin), not the library page's badges, which
//     join every build of a family and ignore a GGUF chat template that Ollama prefers. Ollama (`Model.Capabilities`, with
//     `OLLAMA_GO_TEMPLATE` unset) adds up the config's `capabilities`, the tool and thinking support of its `parser`
//     (devstral-2 `ministral`, qwen3-coder-next `qwen3-coder`, olmo-3.1 `olmo3-think`, lfm2.5-thinking `lfm2-thinking`,
//     qwen3-vl `qwen3-vl-thinking`), vision from a projector layer or the model file's `vision.block_count`, and one
//     template's tools and thinking. A build with a Go template layer uses it (`.Tools` for tools, `.Thinking` in its
//     messages loop for thinking: devstral-2, devstral-small-2, rnj-1, qwen3-next, and Mellum have `.Tools`, and the last
//     two `.Thinking`), unless it has no `parser` or `renderer` and the GGUF's chat template offers more capabilities while
//     keeping any tool round trip the Go template has, or offers the same and alone completes one (MiniCPM5). A build with
//     no Go template layer uses the GGUF's chat template (a `tools` or `tool_call` substring for tools, a literal `<think>`
//     and `</think>` or a split of `content` at `</think>` for thinking), but a build with a `parser` never has it read, so
//     olmo-3.1, qwen3-coder-next, lfm2.5-thinking, and qwen3-vl, which have a parser and no Go template layer, have only
//     what the parser and their config offer. K2 Horizon, which 0.34.0 cannot pull, rests on its config's `capabilities`
//     and the 0.40.16 run below. The pool routes a request that asks for tools or thinking by these flags
//     (`pool-auto-model.ts`). So `olmo-3.1:32b`, the Think build, is thinking without tools, although its family page
//     shows both badges: its parser has no tool support. `olmo-3-7b` and `olmo-3-32b` (2026-08-12) say the opposite (tools,
//     no thinking) for builds with the same parser, and are left for a follow-up.
//   - The vendors' own Ollama namespaces carry two of the "Hugging Face-first" families, so they are listed from there, as
//     `openbmb/minicpm-v4.7` is. MiniCPM5 is two repos: `openbmb/minicpm5` (the 1B, which has no size tag, so `:q4_K_M`)
//     and `openbmb/minicpm5-2b`. K2 Horizon is `ifm/k2-horizon` (0.9B, 3.7B, 7B, 32B, and MoVA 36B-A4B, each by its
//     explicit `-q4_K_M` tag, since the 0.9B and 3.7B defaults are Q8_0). It needs Ollama 0.40.4, above the fleet's pin:
//     its config blobs say `requires` 0.40.4, and the llama.cpp in 0.34.0 (b10760) has no `k2-horizon` architecture while
//     the one in 0.40.16 (b12177) has. The fleet cannot pull those five rows until the pin moves: a node on 0.34.0 asked to
//     pull one should be refused with HTTP 412 (Ollama issues 19085 and 18414; not observed here, since the registry answers
//     an `ollama/` User-Agent with 401 unless it carries Ollama's token), though no K2 row is in a top-5 recommendation.
//     The K2 sizes are the
//     vendor's names (the cards say "3.7B-core" and "7B-core"); the files hold 1.08B, 5.06B, 9.0B, 34.8B, and 37.4B
//     parameters.
//   - MiniCPM5's two builds carry the same 9,062-byte GGUF chat template, which names tools and thinking, while their Go
//     templates (172 and 692 bytes) name neither tools nor `.Thinking`; so Ollama 0.34.0 prefers the GGUF's and reports both,
//     although the library page's badges show none (the 1B) and thinking (the 2B). That is from Ollama's source, and the
//     cards' XML-style tool calls were not run through it. The 2B's params layer holds its stop list as one string that
//     contains a JSON array, so `<|im_end|>` is not a stop sequence of its own there; whether the runner still ends the
//     turn on it was not run. That layer also sets `num_ctx` to 4096, which matters only to a request that sends no
//     context size of its own.
//   - K2 Horizon's chat template. The Q4_K_M files of IFM's five GGUF repos and its five `-q4_K_M` registry builds are the
//     same five files (each model layer's digest equals the repo file's hash), and carry one GGUF chat template (43,040
//     bytes) with no check for a missing thinking field. bartowski's 3.7B, 7B, 32B, MoVA, and 375B GGUFs carry a 51,034-byte one that raises
//     "Assistant message is missing a thinking field" on an assistant turn with none (his 0.9B carries a third, without
//     that check). On Ollama 0.40.16, `ifm/k2-horizon:0.9b-q4_K_M` answered HTTP 200 to a multi-turn chat whose assistant
//     turn has no thinking field, to `think` true and false, and to a tool call with its result. The same model layer
//     through `hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M` chats the same, but its manifest adds its own template and stop
//     parameters, leaves out IFM's temperature and top_p, and reports tools and completion only, so `think: true`
//     answers HTTP 400; the registry build declares thinking and tools in its config, which is why K2 Horizon is listed
//     from IFM's namespace. Only the 0.9B was run; the other four builds share its template, byte for byte.
//   - Through `hf.co/`, where the registry endpoint answers 200 to Ollama's User-Agent (single-file Q4_K_M): JetBrains'
//     `Mellum2.1-12B-A2.5B-Thinking-GGUF` (its own repo, 8.07 GB; JetBrains' Ollama namespace stops at Mellum 2, and
//     `decadence/mellum2.1` is a community re-host of the same file) and `AngelSlim/Hy3-GGUF` (182.33 GB). AngelSlim is an
//     unverified Hugging Face organization, outside Tencent's `tencent/` namespace, that Tencent's AngelSlim README links
//     and whose toolkit Hy3's card names. Hy3's repo lists `Hy3-Q4_K_M-mtp.gguf` beside `Hy3-Q4_K_M.gguf`; the `Q4_K_M`
//     tag serves the plain 80-block file. bartowski's Hy3 Q4_K_M is sharded (HTTP 400), and `frob/hy3` is frob's own
//     Q4_K_M (81 blocks, with the MTP head, 181.0 GB) with the same template. llama.cpp b10760, in Ollama 0.34.0, has both
//     `mellum` and `hy_v3` (Hy3 support came with llama.cpp PR 25395, which merged on 2026-07-13 and is in b10760).
//   - Hy3 carries no thinking flag. Its manifest has no template layer and no `capabilities`, so Ollama 0.34.0 reads the
//     GGUF's chat template: it reports thinking only for a literal `<think>` and `</think>` there (or a split of `content`
//     at `</think>`), and Hy3's template has neither, building its think tokens from a format string, so it would answer
//     `think: true` with HTTP 400, as the `hf.co` K2 Horizon build did on 0.40.16. It reports tools when the template
//     contains `tools` or `tool_call`, which Hy3's does. Both are from Ollama's source and the template, not from a run.
//     The template defaults `reasoning_effort` to `no_think`.
//   - Command A+ is left out, after vetting `coder543/command-a-plus-05-2026-gguf`, the only single-file build found: one
//     132 GB Q4_K_M that the registry request accepts, with a chat template identical to Cohere's and Apache-2.0 on
//     Cohere's card. But it is one person's upload (223 downloads in the past 30 days, 2,936 in all), the GGUFs of
//     bartowski, diablomike20, SixVolts, and DevQuasar are sharded, Ollama's registry search lists no Command A+, and at
//     132 GB it was not run. Its header names no quantizer or base model (nor does Hy3's, so the publisher is what
//     separates the two).
//   - Windows. Devstral Small 2 carries 256K, which Mistral's card states, though its file (393,216) and Ollama's page
//     (384K) allow more. LFM 2.5 Thinking carries 32K, which Liquid's card states, though its file (128,000) and Ollama's
//     page (125K) allow more. The other rows carry their file's token count divided by 1,024, so 256 for the nine whose
//     files run to 262,144 (devstral-2, qwen3-next, qwen3-coder-next, hy3, and the five qwen3-vl sizes, whose pages say
//     256K too), where older rows such as `qwen3-6-27b` and `qwen3-vl-32b` carry 262 (the second, added from an engine
//     reading on 2026-09-09, also carries 33B). 256 is the lower figure, so the safe one for sizing.
//   - Licenses with revenue limits: Devstral 2 123B (a modified MIT that grants no rights to a company whose global
//     consolidated monthly revenue exceeds $20 million) and LFM 2.5 Thinking (LFM Open License v1.0, which does not
//     license commercial use by an entity at $10 million a year or more). The vendors' cards say Apache-2.0 for the rest,
//     Devstral Small 2 among them.
// AA moved its open-weights leaderboard to Intelligence Index v5.0.1; this table's column is v4.3 (2026-09-16). Few
// rows have a v5.0.1 score, so the column stays whole on v4.3 and every row added above leaves intel/tps/ttft/e2e
// blank: a mixed-scale column would rank wrongly.
const CATALOG_TOON = `
llms[146|]{id,backendModelId,name,purpose,params,gb,tier,ctxK,creator,intel,reason,vision,tools,audio,tps,ttft,e2e,ramGb}:
  gemma4-e2b|gemma4:e2b|Gemma 4 E2B|general|2|7.2|cpu-only|128|Google|7.8|1|1|1|1|||
  gemma4-e4b|gemma4:e4b|Gemma 4 E4B|general|4|9.6|cpu-only|128|Google|8.9|1|1|1|1|63.2|0.84|40.4|4.26
  gemma4-12b|gemma4:12b|Gemma 4 12B|general|12|7.6|low|256|Google|14.2|1|1|1|0|114.2|2.46|24.4
  gemma4-26b|gemma4:26b|Gemma 4 26B|general|26|18|medium|256|Google|16.7|1|1|1|0||||18.34
  gemma4-26b-mtp|gemma4:26b-a4b-it-mtp-q4_K_M|Gemma 4 26B (MTP)|general|26|19|medium|256|Google|16.7|1|1|1|0|||
  gemma4-31b|gemma4:31b|Gemma 4 31B|general|31|20|medium|256|Google|19|1|1|1|0|35.6|1|63.9|19.19
  qwen3-8-27b|qwen3.8:27b|Qwen 3.8 27B|reasoning|27|18|medium|256|Alibaba|33.7|1|1|1|0|43.8|3.87|60.9
  qwen3-8-27b-mtp|qwen3.8:27b-mtp-q4_K_M|Qwen 3.8 27B (MTP)|reasoning|27|18|medium|256|Alibaba|33.7|1|1|1|0|43.8|3.87|60.9
  qwen3-6-27b|qwen3.6:27b|Qwen 3.6 27B|coding|27|17|medium|262|Alibaba|21.4|1|1|1|0|56.2|3.68|113.6
  qwen3-6-27b-mtp|qwen3.6:27b-mtp-q4_K_M|Qwen 3.6 27B (MTP)|coding|27|18|medium|262|Alibaba|21.4|1|1|1|0|56.2|3.68|113.6
  qwen3-6-35b|qwen3.6:35b|Qwen 3.6 35B|coding|35|22.6|medium|262|Alibaba|18.2|1|1|1|0|124.1|2.13|49.6
  qwen3-6-35b-mtp|qwen3.6:35b-a3b-mtp-q4_K_M|Qwen 3.6 35B (MTP)|coding|35|23|medium|262|Alibaba|18.2|1|1|1|0|124.1|2.13|49.6
  qwen3-5-0-8b|qwen3.5:0.8b|Qwen 3.5 0.8B|reasoning|0.8|1|cpu-only|262|Alibaba|6.1|1|1|1|0|||
  qwen3-5-2b|qwen3.5:2b|Qwen 3.5 2B|reasoning|2|2.7|cpu-only|262|Alibaba|6.9|1|1|1|0|||
  qwen3-5-4b|qwen3.5:4b|Qwen 3.5 4B|reasoning|4|3.4|cpu-only|262|Alibaba|13.1|1|1|1|0|26.5|0.85|95.1
  qwen3-5-9b|qwen3.5:9b|Qwen 3.5 9B|reasoning|9|6.6|low|262|Alibaba|11.2|1|1|1|0|34.8|2.44|74.4
  qwen3-5-27b|qwen3.5:27b|Qwen 3.5 27B|reasoning|27|17|medium|262|Alibaba|22.9|1|1|1|0|75.6|5.66|38.7
  qwen3-5-35b|qwen3.5:35b|Qwen 3.5 35B|reasoning|35|24|medium|262|Alibaba|19.3|1|1|1|0|146.7|2.12|19.2
  qwen3-5-122b|qwen3.5:122b|Qwen 3.5 122B|reasoning|122|81|high|262|Alibaba|15.6|1|1|1|0|125.5|2.41|22.3
  nemotron3-33b|nemotron3:33b|Nemotron 3 33B|reasoning|33|28|medium||NVIDIA||1|1|1|1|||
  nemotron-3-nano-4b|nemotron-3-nano:4b|Nemotron 3 Nano 4B|reasoning|4|2.8|cpu-only|262|NVIDIA|7.4|1|0|1|0|||
  nemotron-3-nano-30b|nemotron-3-nano:30b|Nemotron 3 Nano 30B|reasoning|30|24|medium|1000|NVIDIA|8.9|1|0|1|0|192.6|1.07|14.1
  nemotron-3-super-120b|nemotron-3-super:120b|Nemotron 3 Super 120B|reasoning|120|87|high|256|NVIDIA|12.8|1|0|1|0|164.6|1.3|16.5
  gpt-oss-20b|gpt-oss:20b|GPT-OSS 20B|general|20|14|medium|131|OpenAI|9|1|0|1|0|166|0.8|15.9
  gpt-oss-120b|gpt-oss:120b|GPT-OSS 120B|general|120|65|high|131|OpenAI|11.6|1|0|1|0|221.6|0.88|12.2
  deepseek-r1-1-5b|deepseek-r1:1.5b|DeepSeek R1 1.5B|reasoning|1.5|1.1|cpu-only||DeepSeek|5.5|1|0|1|0|||
  deepseek-r1-7b|deepseek-r1:7b|DeepSeek R1 7B|reasoning|7|4.7|low||DeepSeek||1|0|1|0|||
  deepseek-r1-8b|deepseek-r1:8b|DeepSeek R1 8B|reasoning|8|5.2|low||DeepSeek|8.1|1|0|1|0|||
  deepseek-r1-14b|deepseek-r1:14b|DeepSeek R1 14B|reasoning|14|9|low||DeepSeek|7.8|1|0|1|0|||
  deepseek-r1-32b|deepseek-r1:32b|DeepSeek R1 32B|reasoning|32|20|medium||DeepSeek|8.4|1|0|1|0|||
  deepseek-r1-70b|deepseek-r1:70b|DeepSeek R1 70B|reasoning|70|43|high||DeepSeek|7.9|1|0|1|0|||
  deepseek-r1-671b|deepseek-r1:671b|DeepSeek R1 671B|reasoning|671|404|high|160|DeepSeek|13.1|1|0|1|0|||
  deepseek-coder-v2-16b|deepseek-coder-v2:16b|DeepSeek Coder V2 16B|coding|16|8.9|medium|160|DeepSeek||0|0|0|0|||
  deepseek-coder-v2-236b|deepseek-coder-v2:236b|DeepSeek Coder V2 236B|coding|236|133|high|4|DeepSeek||0|0|0|0|||
  qwen3-0-6b|qwen3:0.6b|Qwen 3 0.6B|general|0.6|0.5|cpu-only|40|Alibaba|4.8|1|0|1|0|||
  qwen3-1-7b|qwen3:1.7b|Qwen 3 1.7B|general|1.7|1.4|cpu-only|40|Alibaba|5.2|1|0|1|0|||
  qwen3-4b|qwen3:4b|Qwen 3 4B|general|4|2.5|cpu-only|256|Alibaba|7.2|1|0|1|0|||
  qwen3-8b|qwen3:8b|Qwen 3 8B|general|8|5.2|low|40|Alibaba|7.3|1|0|1|0|41.8|3.85|63.7
  qwen3-14b|qwen3:14b|Qwen 3 14B|general|14|9.3|low|40|Alibaba|8.2|1|0|1|0|63.4|2.73|42.2
  qwen3-30b|qwen3:30b|Qwen 3 30B|general|30|19|medium|256|Alibaba|7.6|1|0|1|0|106.7|2.25|25.7
  qwen3-32b|qwen3:32b|Qwen 3 32B|general|32|20|medium|40|Alibaba|8.6|1|0|1|0|106|2.51|26.1
  qwen3-235b|qwen3:235b|Qwen 3 235B|general|235|142|high|256|Alibaba|9.5|1|0|1|0|60.7|2.79|44
  qwq-32b|qwq:32b|QwQ 32B|reasoning|32|20|medium|40|Alibaba|9.5|1|0|1|0|||
  gemma3-270m|gemma3:270m|Gemma 3 270M|general|0.27|0.3|cpu-only|32|Google|5.1|0|0|0|0|||
  gemma3-1b|gemma3:1b|Gemma 3 1B|general|1|0.8|cpu-only|32|Google|4.8|0|0|0|0|||
  gemma3-4b|gemma3:4b|Gemma 3 4B|general|4|3.3|cpu-only||Google|4.8|0|1|0|0|||
  gemma3-12b|gemma3:12b|Gemma 3 12B|general|12|8.1|low||Google|3.8|0|1|0|0|||
  gemma3-27b|gemma3:27b|Gemma 3 27B|general|27|17|medium||Google|4.9|0|1|0|0|||
  gemma3n-e4b|gemma3n:e4b|Gemma 3n E4B|general|7|7.5|low|32|Google|4.8|0|0|0|0|||
  mistral-7b|mistral:7b|Mistral 7B|general|7|4.4|low|32|Mistral|5|0|0|1|0|||
  mistral-nemo-12b|mistral-nemo:12b|Mistral Nemo 12B|general|12|7.1|low||Mistral||0|0|1|0|||
  mistral-small-22b|mistral-small:22b|Mistral Small 22B|general|22|13|medium||Mistral|5.8|0|0|1|0|||
  mistral-small-24b|mistral-small:24b|Mistral Small 24B|general|24|14|medium|32|Mistral|6.7|0|0|1|0|||
  mistral-large-123b|mistral-large:123b|Mistral Large 123B|general|123|73|high||Mistral|7.6|0|0|1|0|||
  mixtral-8x7b|mixtral:8x7b|Mixtral 8X7B|general|47|26|high|32|Mistral|5.1|0|0|1|0|||
  mixtral-8x22b|mixtral:8x22b|Mixtral 8X22B|general|141|80|high|64|Mistral|5.7|0|0|1|0|||
  llama3-2-1b|llama3.2:1b|Llama 3.2 1B|general|1|1.3|cpu-only||Meta|4.8|0|0|1|0|||
  llama3-2-3b|llama3.2:3b|Llama 3.2 3B|general|3|2|cpu-only||Meta|5.7|0|0|1|0|||
  llama3-1-8b|llama3.1:8b|Llama 3.1 8B|general|8|4.9|low||Meta|6.9|0|0|1|0|140.4|0.91|4.5
  llama3-1-70b|llama3.1:70b|Llama 3.1 70B|general|70|43|high||Meta|6.6|0|0|1|0|67.1|1.74|9.2
  llama3-1-405b|llama3.1:405b|Llama 3.1 405B|general|405|243|high|128|Meta|7.3|0|0|1|0|||
  llama3-3-70b|llama3.3:70b|Llama 3.3 70B|general|70|43|high|128|Meta|7.7|0|0|1|0|89|1.63|7.3
  llama4-16x17b|llama4:16x17b|Llama 4 16X17B|general|109|67|high|10000|Meta|8.1|0|1|1|0|132.7|0.84|4.6
  llama4-128x17b|llama4:128x17b|Llama 4 128X17B|general|400|245|high|1000|Meta|10|0|1|1|0|100|0.94|5.9
  glm4-9b|glm4:9b|GLM-4 9B|general|9|5.5|low||Z AI||0|0|1|0|||
  minimax-m2-community-230b|gabegoodhart/minimax-m2:230b|MiniMax M2 230B|general|230|56|high|205|MiniMax|18.6|1|0|1|0|85.7|1.44|30.6
  glm-5-2|hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL|GLM 5.2|reasoning|754|467|high|1000|Z AI|33.7|1|0|1|0|79.1|3.09|34.7
  laguna-xs-2-1|laguna-xs-2.1:latest|Laguna XS 2.1|coding|33|20|medium|256|Poolside||1|0|1|0|||
  laguna-s-2-1|laguna-s-2.1:latest|Laguna S 2.1|coding|118|96|high|256|Poolside||1|0|1|0|||
  ornith-9b|ornith:9b|Ornith 9B|coding|9|5.6|low|256|Deep Reinforce||1|0|1|0|||
  ornith-35b|ornith:35b|Ornith 35B|coding|35|21|medium|256|Deep Reinforce||1|0|1|0|||
  lfm2-5-8b|lfm2.5:8b|LFM 2.5 8B|general|8|5.2|cpu-only|125|Liquid AI|7.2|0|0|1|0|||
  north-mini-code-1-0|north-mini-code-1.0:latest|North Mini Code 1.0|coding|30|19|medium|488|Cohere|9.9|1|0|1|0|67.9|0.43|37.2
  inkling|hf.co/unsloth/inkling-GGUF:UD-Q4_K_XL|Inkling|general|975|587|high|1000|Thinking Machines|25|1|1|1|1|177.4|1.79|15.9
  gemma4-26b-think|bjoernb/gemma4-26b-think:latest|Gemma 4 26B Think|reasoning|26|18|medium|256|Google (community)||1|1|1|0|||
  medgemma1-5-thinking|jordimurgo/medgemma1.5-thinking:q4_K_M|MedGemma 1.5 Thinking|general|4.3|3.3|cpu-only|128|Google (community)||1|1|0|0|||
  muse-glimmer-30b|muse-glimmer:30b|Muse Glimmer|general|30|18|medium|128|Meta|17.5|1|1|1|0|143.8|1.37|18.8
  phi4-14b|phi4:14b|Phi-4 14B|general|14|9.1|low|16|Microsoft|5.9|0|0|1|0|40.5|2.57|14.9
  phi4-mini-3-8b|phi4-mini:3.8b|Phi-4 Mini 3.8B|general|3.8|2.5|cpu-only|128|Microsoft|6.3|0|0|1|0|44.8|0.82|12
  phi4-reasoning-14b|phi4-reasoning:14b|Phi-4 Reasoning 14B|reasoning|14|11|low|32|Microsoft||1|0|1|0|||
  ministral-3-3b|ministral-3:3b|Ministral 3 3B|general|3|3|cpu-only|256|Mistral|4.8|0|1|1|0|200.7|0.72|3.2
  ministral-3-8b|ministral-3:8b|Ministral 3 8B|general|8|6|low|256|Mistral|5.5|0|1|1|0|105.2|0.79|5.5
  ministral-3-14b|ministral-3:14b|Ministral 3 14B|general|14|9.1|low|256|Mistral|6|0|1|1|0|79|0.94|7.3
  command-r-35b|command-r:35b|Command R 35B|general|35|19|medium|128|Cohere||0|0|1|0|||
  command-a-111b|command-a:111b|Command A 111B|general|111|67|high||Cohere|7|0|0|1|0|59.8|1.7|10.1
  olmo-3-7b|olmo-3:7b|OLMo 3 7B|general|7|4.5|low|64|Allen Institute|5.2|0|0|1|0|||
  olmo-3-32b|olmo-3:32b|OLMo 3 32B|general|32|19|medium|64|Allen Institute||0|0|1|0|||
  glm-4-7-flash-30b|glm-4.7-flash:latest|GLM-4.7 Flash|reasoning|30|19|medium|200|Z AI|14.9|1|0|1|0|63.3|1.55|41.1
  nemotron-3-5-lightning-30b|nemotron-3.5-lightning:30b|Nemotron 3.5 Lightning|general|30|25|medium|1000|NVIDIA|12.9|0|0|1|0|286.1|0.62|9.4
  deepseek-v4-flash-0731-284b|frob/deepseek-v4-flash-0731:284b-a13b-ud-q4_k_xl|DeepSeek V4 Flash 0731|reasoning|284|155|high|1000|DeepSeek|34.3|1|0|1|0|218|1.04|12.5
  ornith-1-5-9b|ornith-1.5:9b|Ornith 1.5 9B|coding|9|6.6|low|256|Deep Reinforce||1|1|1|0|||
  ornith-1-5-35b|ornith-1.5:35b|Ornith 1.5 35B|coding|35|23|medium|256|Deep Reinforce||1|1|1|0|||
  ornith-1-5-397b|ornith-1.5:397b|Ornith 1.5 397B|coding|397|242|high|256|Deep Reinforce||1|1|1|0|||
  qwen3-coder-30b|qwen3-coder:30b|Qwen 3 Coder 30B|coding|30|18.6|medium|262|Alibaba|9.6|0|0|1|0|79.7|2.62|8.9
  qwen3-vl-32b|qwen3-vl:32b|Qwen 3 VL 32B|general|33|20.9|medium|262|Alibaba|11.9|1|1|1|0|91|2.71|30.2
  qwen3-coder-480b|qwen3-coder:480b|Qwen 3 Coder 480B|coding|480|290.1|high|262|Alibaba|11.9|0|0|1|0|54.8|3.13|12.2
  qwen2-5-coder-1-5b|qwen2.5-coder:1.5b|Qwen 2.5 Coder 1.5B|coding|1.5|1|cpu-only|32|Alibaba||0|0|1|0|||
  qwen2-5-coder-3b|qwen2.5-coder:3b|Qwen 2.5 Coder 3B|coding|3|1.9|cpu-only|32|Alibaba||0|0|1|0|||
  qwen2-5-coder-7b|qwen2.5-coder:7b|Qwen 2.5 Coder 7B|coding|7|4.7|low|32|Alibaba|5.8|0|0|1|0|||
  qwen2-5-coder-14b|qwen2.5-coder:14b|Qwen 2.5 Coder 14B|coding|14|9|low|32|Alibaba||0|0|1|0|||
  qwen2-5-coder-32b|qwen2.5-coder:32b|Qwen 2.5 Coder 32B|coding|32|19.9|medium|32|Alibaba|6.7|0|0|1|0|||
  devstral-24b|devstral:24b|Devstral 24B|coding|24|14.3|medium|128|Mistral|7.6|0|0|1|0|||
  codestral-22b|codestral:22b|Codestral 22B|coding|22|12.6|medium|32|Mistral||0|0|0|0|||
  deepcoder-1-5b|deepcoder:1.5b|DeepCoder 1.5B|coding|1.5|1.1|cpu-only|64|Agentica||1|0|0|0|||
  deepcoder-14b|deepcoder:14b|DeepCoder 14B|coding|14|9|low|64|Agentica||1|0|0|0|||
  mimo-v2-6-9b|mimo-v2.6:9b|MiMo-V2.6 9B|coding|9|6.6|low|256|Xiaomi||1|1|1|0||||
  flint-40b|flint:40b|Flint 40B|coding|39.8|23|medium|256|Recursive||1|0|1|0||||
  nemotron-3-5-bolt-e4b|nemotron-3.5-bolt:e4b|Nemotron 3.5 Bolt E4B|reasoning|4|7.9|low|128|NVIDIA||1|1|1|0||||
  lfm3-1-7b|lfm3:1.7b|LFM3 1.7B|general|1.7|1.1|cpu-only|256|Liquid AI||1|0|1|0||||
  ripple-preview-65b|ripple-preview:65b|Ripple 65B Preview|coding|65|38.8|high|1000|Ricursive||1|0|1|0||||
  nemotron-3-5-super-120b|nemotron-3.5-super:120b|Nemotron 3.5 Super 120B|reasoning|120|90.2|high|1000|NVIDIA||1|1|1|0||||
  granite4-2-3b|granite4.2:3b|Granite 4.2 3B|general|3|2.2|cpu-only|128|IBM||1|0|1|0||||
  granite4-2-8b|granite4.2:8b|Granite 4.2 8B|general|8|5.3|low|128|IBM||1|0|1|0||||
  granite4-2-30b|granite4.2:30b|Granite 4.2 30B|general|30|17.7|medium|128|IBM||1|0|1|0||||
  lfm3-vl-2b|lfm3-vl:2b|LFM3 VL 2B|general|1.92|1.5|cpu-only|128|Liquid AI||1|1|1|0||||
  lfm2-5-24b|lfm2.5:24b|LFM 2.5 24B|reasoning|24|14.5|medium|128|Liquid AI||1|0|1|0||||
  ornith-1-5-122b|ornith-1.5:122b|Ornith 1.5 122B|coding|122|76.8|high|256|Deep Reinforce||1|1|1|0||||
  nemotron-cascade-2-30b|nemotron-cascade-2:30b|Nemotron Cascade 2 30B|reasoning|30|24.3|medium|256|NVIDIA||1|0|1|0||||
  mistral-medium-3-5-128b|mistral-medium-3.5:128b|Mistral Medium 3.5 128B|general|128|80.2|high|256|Mistral||1|1|1|0||||
  qwen3-8-flash-next-125b|qwen3.8-flash-next:125b-a6b-q4_K_M|Qwen 3.8 Flash Next 125B A6B|reasoning|125|120.1|high|256|Alibaba||1|1|1|0||||
  mistral-small-4-119b|frob/mistral-small-4:119b|Mistral Small 4 119B|general|119|74.6|high|256|Mistral||1|1|1|0||||
  nanbeige4-3-33b|hf.co/bartowski/Nanbeige_Nanbeige4.3-33B-GGUF:Q4_K_M|Nanbeige 4.3 33B|coding|33|20.8|medium|512|Nanbeige||1|0|1|0||||
  arete-27b|hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M|Arete 27B|reasoning|27|18.1|medium|262|Nous Research||1|1|1|0||||
  minicpm-v4-7-35b-a3b|openbmb/minicpm-v4.7:35b-a3b|MiniCPM-V 4.7 35B-A3B|general|35|22.3|medium|256|OpenBMB||0|1|0|0||||
  minicpm-v4-7-1b|openbmb/minicpm-v4.7:1b|MiniCPM-V 4.7 1B|general|1|1.8|cpu-only|256|OpenBMB||0|1|0|0||||
  devstral-small-2-24b|devstral-small-2:24b|Devstral Small 2 24B|coding|24|15.2|medium|256|Mistral||0|1|1|0||||
  devstral-2-123b|devstral-2:123b|Devstral 2 123B|coding|123|74.9|high|256|Mistral||0|0|1|0||||
  qwen3-next-80b|qwen3-next:80b|Qwen 3 Next 80B A3B|reasoning|80|50.4|high|256|Alibaba||1|0|1|0||||
  qwen3-coder-next-80b|qwen3-coder-next:q4_K_M|Qwen 3 Coder Next 80B A3B|coding|80|51.7|high|256|Alibaba||0|0|1|0||||
  olmo-3-1-32b|olmo-3.1:32b|OLMo 3.1 32B|reasoning|32|19.5|medium|64|Allen Institute||1|0|0|0||||
  rnj-1-8b|rnj-1:8b|Rnj-1 8B|coding|8|5.1|low|32|Essential AI||0|0|1|0||||
  lfm2-5-thinking-1-2b|lfm2.5-thinking:1.2b|LFM 2.5 Thinking 1.2B|reasoning|1.2|0.7|cpu-only|32|Liquid AI||1|0|1|0||||
  qwen3-vl-2b|qwen3-vl:2b|Qwen 3 VL 2B|general|2|1.9|cpu-only|256|Alibaba||1|1|1|0||||
  qwen3-vl-4b|qwen3-vl:4b|Qwen 3 VL 4B|general|4|3.3|cpu-only|256|Alibaba||1|1|1|0||||
  qwen3-vl-8b|qwen3-vl:8b|Qwen 3 VL 8B|general|8|6.2|low|256|Alibaba||1|1|1|0||||
  qwen3-vl-30b|qwen3-vl:30b|Qwen 3 VL 30B A3B|general|30|19.6|medium|256|Alibaba||1|1|1|0||||
  qwen3-vl-235b|qwen3-vl:235b|Qwen 3 VL 235B A22B|general|235|143.3|high|256|Alibaba||1|1|1|0||||
  minicpm5-1b|openbmb/minicpm5:q4_K_M|MiniCPM5 1B|general|1|0.7|cpu-only|128|OpenBMB||1|0|1|0||||
  minicpm5-2b|openbmb/minicpm5-2b:2b|MiniCPM5 2B|general|2|1.6|cpu-only|128|OpenBMB||1|0|1|0||||
  k2-horizon-0-9b|ifm/k2-horizon:0.9b-q4_K_M|K2 Horizon 0.9B|reasoning|0.9|0.7|cpu-only|128|IFM||1|0|1|0||||
  k2-horizon-3-7b|ifm/k2-horizon:3.7b-q4_K_M|K2 Horizon 3.7B|reasoning|3.7|3.2|cpu-only|512|IFM||1|0|1|0||||
  k2-horizon-7b|ifm/k2-horizon:7b-q4_K_M|K2 Horizon 7B|reasoning|7|5.6|low|512|IFM||1|0|1|0||||
  k2-horizon-32b|ifm/k2-horizon:32b-q4_K_M|K2 Horizon 32B|reasoning|32|21.1|medium|512|IFM||1|0|1|0||||
  k2-horizon-mova-36b|ifm/k2-horizon:36b-q4_K_M|K2 Horizon MoVA 36B A4B|reasoning|36|22.4|medium|512|IFM||1|0|1|0||||
  mellum2-1-12b|hf.co/JetBrains/Mellum2.1-12B-A2.5B-Thinking-GGUF:Q4_K_M|Mellum 2.1 12B A2.5B|coding|12|8.1|low|128|JetBrains||1|0|1|0||||
  hy3-295b|hf.co/AngelSlim/Hy3-GGUF:Q4_K_M|Hy3 295B A21B|general|295|182.3|high|256|Tencent||0|0|1|0||||
`;

/** A decoded TOON row: every column mapped to its raw string cell (empty string when blank). */
type ToonRow = Record<string, string>;

const ALL_HOST_PLATFORMS: HostPlatform[] = ['darwin', 'linux', 'win32'];

/**
 * Native host platforms supported by the serving implementation behind each catalog table. These
 * are deliberately separate from `gpuVendors`: a model can fit an Apple unified-memory budget but
 * still be impossible to serve through a Linux-only backend (and vice versa). Host-served backends
 * may still be pointed at a remote machine; the platform gate is for automatic local recommendations.
 */
function defaultSupportedPlatforms(backend: InferenceBackendType): HostPlatform[] {
  switch (backend) {
    case 'vllm':
      return ['linux', 'win32'];
    case 'omlx':
      return ['darwin'];
    case 'ollama':
    case 'lemonade':
    case 'localai':
      return [...ALL_HOST_PLATFORMS];
  }
}

/**
 * Minimal decoder for the pipe-delimited tabular TOON subset this catalog uses:
 * a `name[N|]{col,col,...}:` header followed by N indented rows of `|`-separated values.
 * No catalog field contains a pipe, so a plain split is unambiguous (no quoting needed). We avoid the
 * official `@toon-format/toon` package because it is ESM-only and this module loads in the CJS backend.
 */
function decodeToonTable(doc: string, tableName: string): ToonRow[] {
  const lines = doc.split('\n');
  const headerRe = new RegExp(`^${tableName}\\[\\d+\\|\\]\\{.+\\}:$`);
  const headerIdx = lines.findIndex((l) => headerRe.test(l.trim()));
  if (headerIdx === -1) throw new Error(`curated-models: TOON table "${tableName}" not found`);
  const header = (lines[headerIdx] ?? '').trim();
  const match = header.match(/^[A-Za-z_]\w*\[(\d+)\|\]\{(.+)\}:$/);
  if (!match) throw new Error(`curated-models: malformed TOON header for "${tableName}"`);
  const count = Number(match[1]);
  const cols = (match[2] ?? '').split(',');
  const rows: ToonRow[] = [];
  for (let i = headerIdx + 1; i < lines.length && rows.length < count; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    const cells = line.split('|');
    const row: ToonRow = {};
    cols.forEach((col, j) => {
      row[col] = (cells[j] ?? '').trim();
    });
    rows.push(row);
  }
  if (rows.length !== count) {
    throw new Error(`curated-models: TOON declared ${count} rows but parsed ${rows.length}`);
  }
  return rows;
}

const numOrUndef = (s: string | undefined): number | undefined => (s == null || s === '' ? undefined : Number(s));
const flag = (s: string | undefined): boolean => s === '1';

// Active (per-token) parameter count, in billions, for the catalog's
// Mixture-of-Experts models. MoE models read only a small active-expert subset per
// token, so their per-token memory traffic — and thus their speed on shared-memory /
// APU hardware — is governed by this, not the total `params`. Dense models are not
// listed; they default to their full `params`. Values are approximate (vendor-stated
// active sizes) and only need to be good enough for relative ranking.
const MOE_ACTIVE_PARAMS_B: Record<string, number> = {
  'qwen3-30b': 3, // Qwen3-30B-A3B
  'qwen3-235b': 22, // Qwen3-235B-A22B
  'gpt-oss-20b': 3.6, // GPT-OSS 20B (MoE)
  'gpt-oss-120b': 5.1, // GPT-OSS 120B (MoE)
  'mixtral-8x7b': 13, // 2 of 8 ~7B experts active
  'mixtral-8x22b': 39, // 2 of 8 ~22B experts active
  'llama4-16x17b': 17, // Llama 4 Scout — 17B active
  'llama4-128x17b': 17, // Llama 4 Maverick — 17B active
  'nemotron-3-super-120b': 12, // Nemotron 3 Super 120B-A12B
  'deepseek-coder-v2-16b': 2.4, // DeepSeek-Coder-V2-Lite (MoE)
  'deepseek-coder-v2-236b': 21, // DeepSeek-Coder-V2 (MoE)
  'deepseek-r1-671b': 37, // DeepSeek-R1 (MoE)
  'minimax-m2-community-230b': 10, // MiniMax M2 (MoE) — official ollama.com listing shows retired 2026-06-16;
  // AA suggests MiniMax-M2.1 instead. Kept on the community namespace pending a verified successor row.
  'glm-5-2': 40, // GLM-5.2 MoE active params (hf.co GGUF pull, not the ollama.com :cloud tag)
  'laguna-xs-2-1': 3, // Laguna XS 2.1 — 33B-A3B MoE (Poolside)
  'laguna-s-2-1': 8, // Laguna S 2.1 — 118B-A8B MoE (Poolside)
  'lfm2-5-8b': 1.5, // LFM2.5 — 8.3B-A1.5B MoE (Liquid AI)
  'north-mini-code-1-0': 3, // North Mini Code 1.0 — 30B-A3B MoE (Cohere)
  inkling: 41, // Inkling — 975B-A41B sparse MoE (Thinking Machines)
  'gemma4-26b': 3.8, // Gemma 4 26B — 25.2B-A3.8B MoE (confirmed 2026-07-27 re-audit; was missing before)
  'gemma4-26b-mtp': 3.8, // Gemma 4 26B (MTP) — same 25.2B-A3.8B MoE weights as gemma4-26b, plus the trained MTP head
  'qwen3-6-35b': 3, // Qwen 3.6 35B — 36B-A3B MoE (confirmed 2026-07-27 re-audit; was missing before)
  'qwen3-6-35b-mtp': 3, // Qwen 3.6 35B (MTP) — same 36B-A3B MoE weights as qwen3-6-35b, plus the trained MTP head
  'gemma4-26b-think': 3.8, // Gemma 4 26B Think — 25.2B-A3.8B MoE, community thinking-mode variant
  'qwen3-coder-30b-lemonade': 3, // Qwen3-Coder-30B-A3B (Lemonade) — same 30B-A3B MoE arch as qwen3-30b above
  // 2026-09-29 Lemonade expansion — each reuses the matching Ollama-backend row's value above.
  'qwen3-30b-lemonade': 3,
  'gpt-oss-20b-lemonade': 3.6,
  'gpt-oss-120b-lemonade': 5.1,
  'llama4-16x17b-lemonade': 17,
  'lfm2-5-8b-lemonade': 1.5,
  'gemma4-26b-lemonade': 3.8,
  'gemma4-26b-mtp-lemonade': 3.8,
  'qwen3-6-35b-lemonade': 3,
  'qwen3-6-35b-mtp-lemonade': 3,
  'glm-4-7-flash-30b-lemonade': 3,
  'nemotron-3-5-lightning-30b-lemonade': 3,
  'qwen3-coder-30b-vllm': 3, // Qwen3-Coder-30B-A3B (vLLM) — same 30B-A3B MoE arch
  'gpt-oss-20b-vllm': 3.6, // GPT-OSS 20B (vLLM) — same MoE as the Ollama row
  'gpt-oss-120b-vllm': 5.1, // GPT-OSS 120B (vLLM) — same MoE as the Ollama row
  'gpt-oss-20b-mlx': 3.6, // GPT-OSS 20B (vLLM-Metal/MLX) — same MoE as the Ollama row
  'qwen3-30b-a3b-mlx': 3, // Qwen3-30B-A3B-Instruct-2507 (vLLM-Metal/MLX) — same MoE arch as qwen3-30b above
  'glm-4-7-flash-30b': 3, // GLM-4.7 Flash — 30B-A3B MoE
  'nemotron-3-5-lightning-30b': 3, // Nemotron 3.5 Lightning — 30B-A3B MoE
  'deepseek-v4-flash-0731-284b': 13, // DeepSeek V4 Flash 0731 — 284B total / 13B active MoE
  'flint-40b': 2.5, // Flint 40B — 39.8B total / 2.5B active per token, per Recursive's model page
  'ornith-1-5-35b': 3, // Ornith 1.5 35B — 35B-A3B MoE per the library readme; the 9B is dense, the 122B and 397B are MoE (below)
  'qwen3-coder-30b': 3, // Qwen3-Coder-30B-A3B — same 30B-A3B MoE as qwen3-30b/qwen3-coder-30b-vllm above
  'qwen3-coder-480b': 35, // Qwen3-Coder-480B-A35B
  // 2026-08-24 MLX expansion — active params reused from the matching Ollama-backend row above, or
  // (where the base row has no MoE entry) taken directly from the HF repo's own `-A#B` name suffix.
  'gemma4-26b-mlx': 3.8, // Gemma 4 26B (MLX) — same MoE as gemma4-26b above
  'qwen3-6-35b-mlx': 3, // Qwen 3.6 35B (MLX) — same MoE as qwen3-6-35b above
  'qwen3-5-35b-mlx': 3, // Qwen3.5-35B-A3B (MLX) — active size from the HF repo's own -A3B suffix
  'qwen3-5-122b-mlx': 10, // Qwen3.5-122B-A10B (MLX) — active size from the HF repo's own -A10B suffix
  'nemotron-3-nano-30b-mlx': 3, // NVIDIA-Nemotron-3-Nano-30B-A3B (MLX) — active size from the -A3B suffix
  'nemotron-3-super-120b-mlx': 12, // Nemotron 3 Super 120B (MLX) — same MoE as nemotron-3-super-120b above
  'gpt-oss-120b-mlx': 5.1, // GPT-OSS 120B (MLX) — same MoE as gpt-oss-120b-vllm above
  'deepseek-r1-671b-mlx': 37, // DeepSeek R1 671B (MLX) — same MoE as deepseek-r1-671b above
  'deepseek-coder-v2-16b-mlx': 2.4, // DeepSeek Coder V2 16B (MLX) — same MoE as deepseek-coder-v2-16b above
  'qwen3-235b-mlx': 22, // Qwen3-235B-A22B (MLX) — active size from the HF repo's own -A22B suffix
  'mixtral-8x7b-mlx': 13, // Mixtral 8X7B (MLX) — same MoE as mixtral-8x7b above
  'mixtral-8x22b-mlx': 39, // Mixtral 8X22B (MLX) — same MoE as mixtral-8x22b above
  'glm-5-2-mlx': 40, // GLM 5.2 (MLX) — same MoE as glm-5-2 above
  'glm-4-7-flash-30b-mlx': 3, // GLM-4.7 Flash (MLX) — same MoE as glm-4-7-flash-30b above
  'nemotron-3-5-lightning-30b-mlx': 3, // Nemotron 3.5 Lightning (MLX) — same MoE as nemotron-3-5-lightning-30b above
  'deepseek-v4-flash-0731-mlx': 13, // DeepSeek V4 Flash 0731 (MLX) — same MoE as deepseek-v4-flash-0731-284b above
  'north-mini-code-1-0-mlx': 3, // North Mini Code 1.0 (MLX) — same MoE as north-mini-code-1-0 above
  'minimax-m2-mlx': 10, // MiniMax M2 (MLX) — same MoE as minimax-m2-community-230b above
  // 2026-11-15 refresh — vendor-stated active sizes, or the GGUF's expert counts where a vendor states none.
  'nemotron-3-5-super-120b': 12, // Nemotron 3.5 Super 120B-A12B
  'lfm2-5-24b': 2.45, // LFM2.5-24B-A2B — 24B total, 2.45B active per the vendor card (64 experts, 4 used)
  'ornith-1-5-122b': 10, // Ornith 1.5 122B — qwen35moe, 256 experts / 8 used: about 10B active (a Qwen3.5-122B-A10B shape)
  'ornith-1-5-397b': 17, // Ornith 1.5 397B — qwen35moe, 512 experts / 10 used: about 17B active (a Qwen3.5-397B-A17B shape)
  'ornith-35b': 3, // Ornith 1.0 35B — the same qwen35moe 35B-A3B shape as ornith-1-5-35b (it was treated as dense before 2026-11-15)
  'nemotron-cascade-2-30b': 3, // Nemotron Cascade 2 30B-A3B
  'qwen3-8-flash-next-125b': 6, // Qwen 3.8 Flash-Next 125B-A6B
  'mistral-small-4-119b': 6.5, // Mistral Small 4 119B — 6.5B active per the vendor card (title says A6B)
  'minicpm-v4-7-35b-a3b': 3, // MiniCPM-V 4.7 35B-A3B
  'lfm2-5-24b-mlx': 2.45, // LFM2.5 24B (MLX) — same MoE as lfm2-5-24b above
  'qwen3-8-flash-next-125b-mlx': 6, // Qwen 3.8 Flash Next (MLX) — same MoE as qwen3-8-flash-next-125b above
  'laguna-s-2-1-mlx': 8, // Laguna S 2.1 (MLX) — same MoE as laguna-s-2-1 above
  'ornith-35b-mlx': 3, // Ornith 1.0 35B (MLX) — same MoE as ornith-35b above
  'ornith-1-5-35b-mlx': 3, // Ornith 1.5 35B (MLX) — same MoE as ornith-1-5-35b above
  'flint-40b-mlx': 2.5, // Flint 40B (MLX) — same MoE as flint-40b above
  'qwen3-6-35b-vllm': 3, // Qwen3.6-35B-A3B (vLLM) — same MoE as qwen3-6-35b above
  'glm-4-7-flash-30b-vllm': 3, // GLM-4.7 Flash (vLLM) — same 30B-A3B MoE as the Ollama row
  // 2026-11-15 second pass — vendor-stated active sizes, which leave out the embedding tables. An estimate from the GGUFs'
  // expert counts (total less the unused experts' share, embedding tables included) lands within about 1B of each, except
  // K2 Horizon MoVA below.
  'qwen3-next-80b': 3, // Qwen3-Next-80B-A3B — 512 experts, 10 used (qwen3next)
  'qwen3-coder-next-80b': 3, // Qwen3-Coder-Next — 80B total, 3B activated per the vendor card (the same qwen3next shape)
  'qwen3-vl-30b': 3, // Qwen3-VL-30B-A3B — 128 experts, 8 used (qwen3vlmoe)
  'qwen3-vl-235b': 22, // Qwen3-VL-235B-A22B — 128 experts, 8 used (qwen3vlmoe)
  'k2-horizon-mova-36b': 4, // K2-Horizon-MoVA-36B-A4B — "stores 36B parameters and runs 4B per token" per the vendor card; its tensors give about 6B with the embedding and output tables and 4.7B without them
  'mellum2-1-12b': 2.5, // Mellum2.1 12B-A2.5B — 64 experts, 8 used (mellum)
  'hy3-295b': 21, // Hy3 — 295B total, 21B active per the vendor card (192 experts, 8 used)
};

/**
 * Shared TOON-row → CuratedModel mapper for both the Ollama catalog table and any
 * per-backend LLM table (e.g. `LEMONADE_LLM_TOON`) that follows the same column schema.
 * `backend` is a parameter rather than hardcoded so a second backend's table can reuse
 * every derived-field computation (tiers, footprint, MoE active-params) unchanged.
 * `overrides.gpuVendors` lets a table override the per-backend default gpu-vendor gate — used by
 * `VLLM_MLX_LLM_TOON` below, whose rows only run through vLLM-Metal (Apple Silicon), not the CUDA
 * image every other vLLM row targets.
 */
function buildLlmModel(
  row: ToonRow,
  backend: InferenceBackendType,
  overrides?: {
    gpuVendors?: CuratedModel['requirements']['gpuVendors'];
    supportedPlatforms?: HostPlatform[];
  },
): CuratedModel {
  // Per-row `quant` column (vLLM and Lemonade tables) wins; otherwise Ollama rows are
  // the q4_K_M default build, and vLLM serves the raw bf16 safetensors.
  const quantization = row.quant || (backend === 'vllm' ? 'bf16' : 'q4_K_M');
  const params = Number(row.params);
  const gb = Number(row.gb);
  const tier = (row.tier ?? 'cpu-only') as HardwareTier;
  const diskMb = Math.round(gb * 1024);
  // Optional `ramGb` column: resident RAM stated directly, for rows where it is NOT a fixed
  // multiple of on-disk size. Every row without the column keeps the
  // historical `diskMb * 1.1` exactly (asserted in curated-models.test.ts). A stated figure is a
  // measurement (see the 2026-09-30 note above CATALOG_TOON), so the row says so: context sizing
  // then trusts it over the file size, which for gemma4 E4B is twice what the card holds.
  const ramGb = numOrUndef(row.ramGb);
  // Runtime RAM ≈ weights on disk plus KV-cache / runtime overhead. The tier budget fractions
  // (0.9 VRAM, 0.7 unified/RAM) provide the remaining headroom for the OS, app container, and context.
  const footprintMb = ramGb === undefined ? Math.round(diskMb * 1.1) : Math.round(ramGb * 1024);
  const reasoning = flag(row.reason);
  const vision = flag(row.vision);
  const audio = flag(row.audio);
  const tools = flag(row.tools);
  const contextWindowK = numOrUndef(row.ctxK);
  const intelligenceIndex = numOrUndef(row.intel);
  const tokensPerSec = numOrUndef(row.tps);
  const firstChunkSeconds = numOrUndef(row.ttft);
  const totalResponseSeconds = numOrUndef(row.e2e);

  const input: ('text' | 'image' | 'audio')[] = ['text'];
  if (vision) input.push('image');
  if (audio) input.push('audio');

  const perf =
    tokensPerSec !== undefined || firstChunkSeconds !== undefined || totalResponseSeconds !== undefined
      ? { tokensPerSec, firstChunkSeconds, totalResponseSeconds }
      : undefined;

  return {
    id: row.id ?? '',
    backend,
    backendModelId: row.backendModelId ?? '',
    modality: 'llm',
    purpose: (row.purpose ?? 'general') as ModelPurpose,
    displayName: row.name ?? '',
    description: `${row.name} — ${row.creator || 'open'} model for ${tier} tier systems.`,
    parameterScale: params,
    activeParameterScale: MOE_ACTIVE_PARAMS_B[row.id ?? ''] ?? params,
    requirements: {
      // Anchor the memory requirements on resident RAM when a row states it (`ramGb`), and on
      // on-disk size otherwise. The `ramGb === undefined` arms are the historical expressions,
      // left byte-identical so adding this column moved no existing row.
      minVramMb: ramGb === undefined ? diskMb : footprintMb,
      recommendedVramMb: ramGb === undefined ? Math.round(diskMb * 1.1 + 1024) : Math.round(footprintMb + 1024),
      minRamMb: ramGb === undefined ? Math.round(diskMb * 1.15) : Math.round(footprintMb * 1.05),
      diskMb,
      // vLLM has no CPU serving path in the Hub and no viable AMD/generic-Apple image (see
      // VllmBackend.getComposeConfig), so its rows must only match an NVIDIA VRAM budget by default.
      // Listing 'cpu' here resurrects VRAM-rejected models through the system-RAM fallback
      // in ModelRegistryService.selectLlmsForHardware, recommending models that OOM (#1103).
      // `overrides.gpuVendors` (VLLM_MLX_LLM_TOON) replaces this default for rows that run through
      // vLLM-Metal instead — see the comment above that table for why those are 'apple'-only.
      gpuVendors: overrides?.gpuVendors ?? (backend === 'vllm' ? ['nvidia'] : ['nvidia', 'amd', 'apple', 'cpu']),
      supportedPlatforms: overrides?.supportedPlatforms ?? defaultSupportedPlatforms(backend),
      npuRequired: false,
      minTier: tier,
    },
    runtime: {
      contextWindow: contextWindowK ? contextWindowK * 1000 : 131072,
      maxTokens: 8192,
      reasoning,
      input,
      quantization,
      pinnedByDefault: params <= 4,
      memoryFootprintMb: footprintMb,
      ...(ramGb === undefined ? {} : { footprintMeasured: true }),
    },
    tiers: {
      high: tier === 'high' ? 'recommended' : 'available',
      medium: tier === 'medium' ? 'recommended' : tier === 'high' ? 'not-recommended' : 'available',
      low: tier === 'low' ? 'recommended' : tier === 'high' || tier === 'medium' ? 'not-recommended' : 'available',
      // CPU inference is viable for small/mid models. Mark cpu-only sizes 'recommended' and low-tier
      // sizes 'available' so the catalog's CPU-only browse set covers what the recommender can pick.
      cpuOnly: tier === 'cpu-only' ? 'recommended' : tier === 'low' ? 'available' : 'not-recommended',
    },
    metadata: {
      ...(row.creator ? { creator: row.creator } : {}),
      ...(intelligenceIndex === undefined ? {} : { intelligenceIndex }),
      capabilities: { reasoning, vision, tools, audio },
      ...(perf ? { perf } : {}),
    },
  };
}

const generatedLlms: CuratedModel[] = decodeToonTable(CATALOG_TOON, 'llms').map((row) => buildLlmModel(row, 'ollama'));

// ─── Lemonade LLM catalog (TOON) ─────────────────────────────────────────────
// A small, separately-verified set of Lemonade-backend chat/coding/vision models — kept in its own
// table rather than folded into CATALOG_TOON above so the well-audited Ollama table (see its header
// comment) is untouched. Every row's `checkpoint`/`size` was cross-checked 2026-07-28 against the raw
// `src/cpp/resources/server_models.json` fetched directly from github.com/lemonade-sdk/lemonade (not a
// paraphrased/summarized fetch — see the fabrication-guard precedent above for why that distinction
// matters in this file). `backendModelId` is the exact registry key Lemonade's `/v1/pull` and
// `/v1/models` expect. reason/vision/tools flags are taken directly from that file's own `labels`
// array per model rather than assumed from the base model family, since Lemonade's serving harness
// (not Ollama's) is what determines what's actually supported through this backend. `intel` is not
// in this table: each row takes its Ollama partner's at build time (see `withOllamaPartnerIntel`).
// Perf figures stay blank. Every row is `recipe: "llamacpp"` in that file, so — like Ollama's own
// llama.cpp-based serving — they run across nvidia/amd/apple/cpu, not only AMD Ryzen AI NPU hardware.
//
// 2026-09-29: added 37 rows, one per Ollama-table row above whose model is also in Lemonade's
// registry. Read from the raw `server_models.json` shipped by lemonade-server 2026.39.1
// (/usr/share/lemonade-server/resources/), not a fetched summary. Joined by hand on model identity,
// with the operator confirming each pair. `backendModelId`, `gb` and the reason/vision/tools flags
// come from Lemonade's entry; purpose/params/tier/ctxK/creator from the matching Ollama row (id minus
// the `-lemonade` suffix). intel is the Ollama partner's (below); perf stays blank.
// Four pairs are the same family but not provably the same release: devstral-24b ↔ Devstral-Small-2507,
// deepseek-r1-8b ↔ R1-0528-Qwen3-8B, qwen3-30b ↔ the original Qwen3-30B-A3B (not -Instruct-2507), and
// llama4-16x17b ↔ Llama-4-Scout. GPT-OSS uses Lemonade's MXFP4 builds (the format OpenAI released and
// Ollama ships), not the unsloth Q4_K_M ones.
//
// `quant` is the quantization named in each entry's `checkpoint` (or `checkpoints.main`) tag, lowercased
// to this file's `q4_K_M` spelling; unsloth's Dynamic builds keep their `UD-` marker as `ud-`. The one
// checkpoint with no tag, `ggml-org/gpt-oss-20b-GGUF`, takes `mxfp4` from Lemonade's own registry key.
//
// Rows name 2026.39.1's registry, not every Lemonade's: the 10.2.0 apt package on every fleet Lemonade
// node lacks 13 of them (Gemma-4-12B-it, Gemma-4-26B-A4B-it-MTP, Qwen3.8-27B, Qwen3.6-27B and its MTP
// build, Qwen3.6-35B-A3B and its MTP build, Qwen3.5-122B-A10B, gpt-oss-120b-mxfp, Nemotron 3.5 Lightning,
// Muse Glimmer, LFM2.5-8B-A1B, Llama-4-Scout). The registry service drops any row the connected
// server's `GET /v1/models?show_all=true` does not list (`LemonadeBackend.offersModel`), so these stay
// in the table for newer servers and never reach a node that cannot pull them.
//
// 2026-09-30: `qwen3-8-27b-lemonade` takes its registry size, 18.8, like the other 40 rows. It carried
// 17.2, its files measured in GiB (17,630 MiB), a different unit from the rest of the column. That
// measurement's companion now sets the footprint instead: `ramGb` 18.04 is what Lemonade held at 8192
// tokens (19,017 MiB, see MEASURED_KV_MB_PER_TOKEN) less that window's 546 MiB of KV. Its compute
// buffers were not recorded, so unlike the gemma4 figures above they are still in it. Derived from
// 18.8, the footprint would have charged 2.7 GB more than the model was seen to use.
const LEMONADE_LLM_TOON = `
llms[41|]{id,backendModelId,name,purpose,params,gb,tier,ctxK,creator,intel,reason,vision,tools,audio,tps,ttft,e2e,quant,ramGb}:
  llama3-2-3b-lemonade|Llama-3.2-3B-Instruct-GGUF|Llama 3.2 3B (Lemonade)|general|3|2.06|cpu-only||Meta||0|0|0|0||||ud-q4_K_XL
  qwen3-8b-lemonade|Qwen3-8B-GGUF|Qwen 3 8B (Lemonade)|reasoning|8|5.25|low||Alibaba||1|0|0|0||||q4_1
  gemma4-12b-lemonade|Gemma-4-12B-it-GGUF|Gemma 4 12B (Lemonade)|general|12|7.29|low||Google||0|1|1|0||||q4_K_M
  qwen3-coder-30b-lemonade|Qwen3-Coder-30B-A3B-Instruct-GGUF|Qwen 3 Coder 30B (Lemonade)|coding|30|18.6|medium||Alibaba||0|0|1|0||||q4_K_M
  gemma4-e2b-lemonade|Gemma-4-E2B-it-GGUF|Gemma 4 E2B (Lemonade)|general|2|4.09|cpu-only|128|Google||0|1|1|0||||q4_K_M
  gemma4-e4b-lemonade|Gemma-4-E4B-it-GGUF|Gemma 4 E4B (Lemonade)|general|4|5.97|cpu-only|128|Google||0|1|1|0||||q4_K_M
  gemma4-26b-lemonade|Gemma-4-26B-A4B-it-GGUF|Gemma 4 26B (Lemonade)|general|26|18.1|medium|256|Google||0|1|1|0||||ud-q4_K_M
  gemma4-26b-mtp-lemonade|Gemma-4-26B-A4B-it-MTP-GGUF|Gemma 4 26B (MTP, Lemonade)|general|26|18.5|medium|256|Google||0|1|1|0||||ud-q4_K_M
  gemma4-31b-lemonade|Gemma-4-31B-it-GGUF|Gemma 4 31B (Lemonade)|general|31|19.5|medium|256|Google||0|1|1|0||||q4_K_M
  qwen3-8-27b-lemonade|Qwen3.8-27B-GGUF|Qwen 3.8 27B (Lemonade)|reasoning|27|18.8|medium|256|Alibaba||1|1|1|0||||ud-q4_K_XL|18.04
  qwen3-6-27b-lemonade|Qwen3.6-27B-GGUF|Qwen 3.6 27B (Lemonade)|coding|27|18.5|medium|262|Alibaba||0|1|1|0||||ud-q4_K_XL
  qwen3-6-27b-mtp-lemonade|Qwen3.6-27B-MTP-GGUF|Qwen 3.6 27B (MTP, Lemonade)|coding|27|18.8|medium|262|Alibaba||0|1|1|0||||ud-q4_K_XL
  qwen3-6-35b-lemonade|Qwen3.6-35B-A3B-GGUF|Qwen 3.6 35B (Lemonade)|coding|35|23.3|medium|262|Alibaba||0|1|1|0||||ud-q4_K_XL
  qwen3-6-35b-mtp-lemonade|Qwen3.6-35B-A3B-MTP-GGUF|Qwen 3.6 35B (MTP, Lemonade)|coding|35|23.8|medium|262|Alibaba||0|1|1|0||||ud-q4_K_XL
  qwen3-5-0-8b-lemonade|Qwen3.5-0.8B-GGUF|Qwen 3.5 0.8B (Lemonade)|reasoning|0.8|0.764|cpu-only|262|Alibaba||0|1|1|0||||ud-q4_K_XL
  qwen3-5-2b-lemonade|Qwen3.5-2B-GGUF|Qwen 3.5 2B (Lemonade)|reasoning|2|2.01|cpu-only|262|Alibaba||0|1|1|0||||ud-q4_K_XL
  qwen3-5-4b-lemonade|Qwen3.5-4B-GGUF|Qwen 3.5 4B (Lemonade)|reasoning|4|3.58|cpu-only|262|Alibaba||0|1|1|0||||ud-q4_K_XL
  qwen3-5-9b-lemonade|Qwen3.5-9B-GGUF|Qwen 3.5 9B (Lemonade)|reasoning|9|6.88|low|262|Alibaba||0|1|1|0||||ud-q4_K_XL
  qwen3-5-27b-lemonade|Qwen3.5-27B-GGUF|Qwen 3.5 27B (Lemonade)|reasoning|27|18.5|medium|262|Alibaba||0|1|1|0||||ud-q4_K_XL
  qwen3-5-35b-lemonade|Qwen3.5-35B-A3B-GGUF|Qwen 3.5 35B (Lemonade)|reasoning|35|23.1|medium|262|Alibaba||0|1|1|0||||ud-q4_K_XL
  qwen3-5-122b-lemonade|Qwen3.5-122B-A10B-GGUF|Qwen 3.5 122B (Lemonade)|reasoning|122|77.9|high|262|Alibaba||0|1|1|0||||ud-q4_K_XL
  qwen3-0-6b-lemonade|Qwen3-0.6B-GGUF|Qwen 3 0.6B (Lemonade)|general|0.6|0.38|cpu-only|40|Alibaba||1|0|0|0||||q4_0
  qwen3-1-7b-lemonade|Qwen3-1.7B-GGUF|Qwen 3 1.7B (Lemonade)|general|1.7|1.06|cpu-only|40|Alibaba||1|0|0|0||||q4_0
  qwen3-4b-lemonade|Qwen3-4B-GGUF|Qwen 3 4B (Lemonade)|general|4|2.38|cpu-only|256|Alibaba||1|0|0|0||||q4_0
  qwen3-14b-lemonade|Qwen3-14B-GGUF|Qwen 3 14B (Lemonade)|general|14|8.54|low|40|Alibaba||1|0|0|0||||q4_0
  gpt-oss-20b-lemonade|gpt-oss-20b-mxfp4-GGUF|GPT-OSS 20B (Lemonade)|general|20|12.1|medium|131|OpenAI||1|0|1|0||||mxfp4
  gpt-oss-120b-lemonade|gpt-oss-120b-mxfp-GGUF|GPT-OSS 120B (Lemonade)|general|120|63.4|high|131|OpenAI||1|0|1|0||||mxfp4
  nemotron-3-nano-30b-lemonade|Nemotron-3-Nano-30B-A3B-GGUF|Nemotron 3 Nano 30B (Lemonade)|reasoning|30|22.8|medium|1000|NVIDIA||0|0|0|0||||ud-q4_K_XL
  nemotron-3-5-lightning-30b-lemonade|NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF|Nemotron 3.5 Lightning (Lemonade)|general|30|25.5|medium|1000|NVIDIA||1|0|1|0||||ud-q4_K_XL
  glm-4-7-flash-30b-lemonade|GLM-4.7-Flash-GGUF|GLM-4.7 Flash (Lemonade)|reasoning|30|17.5|medium|200|Z AI||0|0|1|0||||ud-q4_K_XL
  muse-glimmer-30b-lemonade|Muse-Glimmer-30B-GGUF|Muse Glimmer (Lemonade)|general|30|19.9|medium|128|Meta||1|1|1|0||||ud-q4_K_XL
  qwen2-5-coder-32b-lemonade|Qwen2.5-Coder-32B-Instruct-GGUF|Qwen 2.5 Coder 32B (Lemonade)|coding|32|19.9|medium|32|Alibaba||0|0|0|0||||q4_K_M
  gemma3-4b-lemonade|Gemma-3-4b-it-GGUF|Gemma 3 4B (Lemonade)|general|4|3.34|cpu-only||Google||0|1|0|0||||q4_K_M
  llama3-2-1b-lemonade|Llama-3.2-1B-Instruct-GGUF|Llama 3.2 1B (Lemonade)|general|1|0.834|cpu-only||Meta||0|0|0|0||||ud-q4_K_XL
  phi4-mini-3-8b-lemonade|Phi-4-mini-instruct-GGUF|Phi-4 Mini 3.8B (Lemonade)|general|3.8|2.49|cpu-only|128|Microsoft||0|0|0|0||||q4_K_M
  ministral-3-3b-lemonade|Ministral-3-3B-Instruct-2512-GGUF|Ministral 3 3B (Lemonade)|general|3|2.99|cpu-only|256|Mistral||0|1|0|0||||q4_K_M
  lfm2-5-8b-lemonade|LFM2.5-8B-A1B|LFM 2.5 8B (Lemonade)|general|8|5.16|cpu-only|125|Liquid AI||0|0|0|0||||q4_K_M
  devstral-24b-lemonade|Devstral-Small-2507-GGUF|Devstral 24B (Lemonade)|coding|24|14.3|medium|128|Mistral||0|0|1|0||||q4_K_M
  deepseek-r1-8b-lemonade|DeepSeek-Qwen3-8B-GGUF|DeepSeek R1 8B (Lemonade)|reasoning|8|5.25|low||DeepSeek||1|0|0|0||||q4_1
  qwen3-30b-lemonade|Qwen3-30B-A3B-GGUF|Qwen 3 30B (Lemonade)|general|30|17.4|medium|256|Alibaba||1|0|0|0||||q4_0
  llama4-16x17b-lemonade|Llama-4-Scout-17B-16E-Instruct-GGUF|Llama 4 16X17B (Lemonade)|general|109|63.2|high|10000|Meta||0|1|0|0||||q4_K_S
`;

/**
 * 2026-09-29: Lemonade rows are scored like Ollama's. The Intelligence Index describes a MODEL, not a
 * serving stack: Artificial Analysis runs its evaluations against hosted APIs, never through Ollama or
 * Lemonade, so an Ollama row's score was never a measurement of Ollama's q4_K_M file either. Leaving
 * Lemonade blank made every Lemonade model score 0 in `compareLlmCandidates`, which then picked the
 * Lemonade default by size alone. As a rough comparator the relative gap between two models holds on
 * either engine, so each row takes its Ollama partner's (same id minus `-lemonade`) — read here, not
 * copied into the table, so a re-pull of the Ollama column moves both together.
 *
 * The reason flags of 19 pairs differ (Lemonade's labels omit `reasoning` for Qwen 3.5/3.6 and Gemma 4,
 * which think by default from the same weights); the score is taken anyway. Not scored:
 * `qwen3-30b-lemonade` — the original Qwen3-30B-A3B, a different AA entry from what Ollama's
 * `qwen3:30b` serves. A row's own `intel`, if the table ever carries one, wins over its partner's.
 * Three pairs the table's
 * header calls unprovable are the same AA entry the Ollama row was mapped to (see the 2026-09-16 note):
 * devstral-24b (Devstral Small Jul '25 = 2507), deepseek-r1-8b (R1 0528 Qwen3 8B), llama4-16x17b (Scout).
 */
const LEMONADE_ROWS_NOT_SCORED_FROM_OLLAMA = new Set(['qwen3-30b-lemonade']);
const ollamaIntelById = new Map(decodeToonTable(CATALOG_TOON, 'llms').map((row) => [row.id, row.intel]));

function withOllamaPartnerIntel(row: ToonRow): ToonRow {
  const id = row.id ?? '';
  if (row.intel || LEMONADE_ROWS_NOT_SCORED_FROM_OLLAMA.has(id)) return row;
  const intel = ollamaIntelById.get(id.replace(/-lemonade$/, ''));
  return intel ? { ...row, intel } : row;
}

const lemonadeLlms: CuratedModel[] = decodeToonTable(LEMONADE_LLM_TOON, 'llms').map((row) => buildLlmModel(withOllamaPartnerIntel(row), 'lemonade'));

// ─── vLLM LLM catalog (TOON) ─────────────────────────────────────────────────
// Chat models for the vLLM backend. `backendModelId` is the exact HuggingFace repo id that
// `vllm serve <repo>` loads (vLLM has no pull registry of its own — VllmBackend.pullModel documents
// that models are configured at container startup). Selection criteria, in the spirit of this file's
// fabrication-guard history: every row is a widely-known, UNGATED HF repo whose exact id predates and
// survives independent verification (Qwen3 April 2025, Qwen3-2507 refresh July 2025, GPT-OSS August
// 2025, Phi-4 December 2024) — no gated repos (meta-llama/*, Google's Gemma 1 to 3 repos such as google/gemma-3-*) since those 401 without
// an HF token the Hub doesn't manage, and no rows sourced from this session's own web research.
// 2026-11-15: five rows added for current families whose repos are newer than that list (Qwen3.8 27B, Qwen3.6
// 35B-A3B, Qwen3.5 9B, Gemma 4 31B, GLM-4.7 Flash). The same bar, applied to the Hugging Face API instead of
// a summary: each repo's `gated` is false and an anonymous ranged read of its first safetensors shard
// answers 206 (Gemma 4, unlike Gemma 3, is Apache-2.0 and ungated); `gb` is the summed bf16 shard bytes; the
// first `architectures` entry is registered in vLLM's model registry (main and v0.33.0); params, context
// and capability flags follow the vendor card and the repo's `config.json`. None was served with `vllm
// serve` (no GPU was available), so loading is untested. `tools` = 1 means the chat template supports tools:
// vLLM still needs `--enable-auto-tool-choice` and a `--tool-call-parser` at launch, as with the rows above.
// Left out on purpose: `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16` (the card calls that repo mainly a
// customization base and points deployments at NVFP4, which this table does not allow).
// Sizes are the actual serving footprint: bf16 safetensors (≈2 bytes/param) for most rows; the two
// GPT-OSS rows ship natively MXFP4-quantized so their on-disk/VRAM size is far below 2 bytes/param.
// intel/perf columns are left blank rather than copied from the Ollama rows — AA benchmarks
// specific serving setups, and none of these bf16/MXFP4 checkpoints were re-verified under vLLM.
// The extra trailing `quant` column names the served precision (see buildLlmModel).
const VLLM_LLM_TOON = `
llms[13|]{id,backendModelId,name,purpose,params,gb,tier,ctxK,creator,intel,reason,vision,tools,audio,tps,ttft,e2e,quant}:
  qwen3-4b-instruct-vllm|Qwen/Qwen3-4B-Instruct-2507|Qwen 3 4B Instruct (vLLM)|general|4|8.1|low|262|Alibaba||0|0|1|0||||bf16
  qwen3-8b-vllm|Qwen/Qwen3-8B|Qwen 3 8B (vLLM)|general|8|16.4|medium|32|Alibaba||1|0|1|0||||bf16
  qwen3-14b-vllm|Qwen/Qwen3-14B|Qwen 3 14B (vLLM)|general|15|29.6|high|32|Alibaba||1|0|1|0||||bf16
  qwen3-32b-vllm|Qwen/Qwen3-32B|Qwen 3 32B (vLLM)|general|33|65.6|high|32|Alibaba||1|0|1|0||||bf16
  qwen3-coder-30b-vllm|Qwen/Qwen3-Coder-30B-A3B-Instruct|Qwen 3 Coder 30B (vLLM)|coding|30|61|high|262|Alibaba||0|0|1|0||||bf16
  gpt-oss-20b-vllm|openai/gpt-oss-20b|GPT-OSS 20B (vLLM)|general|20|13.8|medium|131|OpenAI||1|0|1|0||||mxfp4
  gpt-oss-120b-vllm|openai/gpt-oss-120b|GPT-OSS 120B (vLLM)|general|120|65|high|131|OpenAI||1|0|1|0||||mxfp4
  phi-4-vllm|microsoft/phi-4|Phi-4 (vLLM)|general|15|29.4|high|16|Microsoft||0|0|0|0||||bf16
  qwen3-8-27b-vllm|Qwen/Qwen3.8-27B|Qwen 3.8 27B (vLLM)|reasoning|27|55.6|high|262|Alibaba||1|1|1|0||||bf16
  qwen3-6-35b-vllm|Qwen/Qwen3.6-35B-A3B|Qwen 3.6 35B (vLLM)|coding|35|71.9|high|262|Alibaba||1|1|1|0||||bf16
  gemma4-31b-vllm|google/gemma-4-31B-it|Gemma 4 31B (vLLM)|general|31|62.5|high|256|Google||1|1|1|0||||bf16
  qwen3-5-9b-vllm|Qwen/Qwen3.5-9B|Qwen 3.5 9B (vLLM)|reasoning|9|19.3|medium|262|Alibaba||1|1|1|0||||bf16
  glm-4-7-flash-30b-vllm|zai-org/GLM-4.7-Flash|GLM-4.7 Flash (vLLM)|reasoning|30|62.4|high|202|Z AI||1|0|1|0||||bf16
`;

const vllmLlms: CuratedModel[] = decodeToonTable(VLLM_LLM_TOON, 'llms').map((row) => buildLlmModel(row, 'vllm'));

// ─── vLLM-Metal (MLX / Apple Silicon) LLM catalog (TOON) ─────────────────────
// Chat models for vLLM running on Apple Silicon via vllm-metal (github.com/vllm-project/vllm-metal),
// a community-maintained vLLM hardware plugin that uses MLX as its compute backend — NOT the CUDA
// `vllm/vllm-openai` image the table above targets. It has no Docker path (Docker Desktop on macOS
// can't reach Metal); it installs into a native venv on the host and is started with the normal
// `vllm serve <repo>` CLI once activated, same OpenAI-compatible surface VllmBackend already talks to
// (see VllmBackend.getComposeConfig, which declines to deploy the CUDA image on `apple` for this
// reason). Requires macOS 15+ and native arm64 Python 3.12 — see vllm-metal's own docs.
//
// `backendModelId` is the exact `mlx-community/...` HuggingFace repo id `vllm serve` loads. Every row
// was checked live against huggingface.co on 2026-08-24 (hub_repo_search + hf_fs directory listing,
// not a paraphrased fetch — see the fabrication-guard precedent in the header comment above) to
// confirm the repo exists and to sum its real `.safetensors` shard sizes for `gb` (decimal GB,
// bytes/1e9) — the same real-artifact-size discipline the Ollama table above applies to ollama.com.
// `params`/`ctxK`/purpose/capability flags are reused from the matching Ollama-backend row for the
// same base model (architecture and context length don't change with the serving engine or
// quantization format) rather than re-derived. intel/perf columns are left blank for the same
// reason the CUDA vLLM table leaves them blank: none of these MLX-quantized checkpoints have been
// benchmarked by Artificial Analysis under vLLM-Metal specifically.
//
// `gpuVendors` is overridden to `['apple']` (see buildLlmModel) — these repos are MLX-quantized
// safetensors and only run through vllm-metal; they must never compete for an NVIDIA VRAM budget.
//
// 2026-08-24 expansion: broadened from the initial 6 rows to cover every Ollama-catalog LLM family
// above that has a real, live mlx-community (or, for `command-r-35b-mlx`, an official-org `mlx`
// namespace) quant — checked the same way as the initial 6 (hub_repo_search + hf_fs directory
// listing, real summed `.safetensors` bytes, not web search). Not every catalog family has one:
// checked and confirmed NO mlx-community/MLX-tagged quant exists (as of 2026-08-24) for Poolside's
// Laguna S/XS 2.1 (`laguna-s-2-1`/`laguna-xs-2-1` — official quants are GGUF/vLLM-NVFP4/INT4/FP8
// only), Deep Reinforce's Ornith (`ornith-9b`/`ornith-35b`), Liquid AI's LFM 2.5 8B (`lfm2-5-8b` —
// only the older, unrelated LFM2-24B-A2B has an MLX quant, via lmstudio-community not mlx-community),
// Thinking Machines' Inkling (`inkling`), Cohere's Command A (`command-a-111b` — only the older,
// smaller Command R family has one), Llama 4 Scout/Maverick (`llama4-16x17b`/`llama4-128x17b`),
// the dense Nemotron 3 33B (`nemotron3-33b`), and the original Mistral Small 22B/2409
// (`mistral-small-22b` — only newer 24B+ releases have been quantized). Community fine-tune rows
// (`gemma4-26b-think`, `medgemma1-5-thinking`) and the non-standard `AQ4_1`-quantized
// `deepseek-coder-v2-236b` were not pursued. `params`/`ctxK`/purpose/capability flags for every row
// below are reused from the matching Ollama-backend row as before; MoE active-params are added to
// MOE_ACTIVE_PARAMS_B below where the HF repo name itself states an `-A#B` active-expert size.
//
// 2026-11-15: re-checked against the Hugging Face API (listing, file tree, `config.json`, summed `.safetensors`
// bytes). Some of the "no quant" verdicts above no longer hold, and some never did: mlx-community already had
// Laguna XS 2.1 and S 2.1 (July) and Ornith 1.0 9B/35B (June). Twelve rows are added for the 2026 releases:
// Laguna S 2.1, Ornith 1.0 and 1.5, the four Ollama rows of 2026-11-08 (flint, mimo-v2.6 9B, nemotron-3.5 Bolt
// E4B, lfm3 1.7B), and the three Ollama rows of 2026-11-15 that have a partner (LFM3 VL 2B, LFM2.5 24B, Qwen3.8
// Flash-Next). Laguna XS 2.1 (`mlx-community/Laguna-XS-2.1-4bit`, 18.8 GB) is the one partner left out: every
// oMLX row is unscored, so ranking falls back to parameter count, and its 33B would displace DeepSeek R1 32B
// as the default on a 32 GB Mac. `flint-40b-mlx` does become the default on a 40 GB Mac, but Apple ships no such
// Mac. Moving a default on a size that ships needs an owner's decision (scoring oMLX rows from their Ollama
// partners, as Lemonade rows are, would settle it).
// Nine of the twelve are OptiQ or oQ4e mixed-precision builds, labelled `mlx-4bit` because that is the family
// label on their cards; `gb` is the real shard sum (about 4.4 to 7.5 bits per weight, with the small vision rows
// at the top), so the footprint matches the download. Only existence, size, and architecture were checked, not
// a load. The cards and release notes say Laguna needs oMLX 0.5.3 or later and Flint one with Flint support (0.7.3
// or later). The LFM3 repos and Laguna S 2.1 ship modeling code behind an `auto_map` (byte-identical to the
// vendors' files), but oMLX builds those models from its own Laguna and LFM3 code and runs repo code only for a
// model with `trust_remote_code` switched on (off by default). LFM3 VL, Ornith 1.5 35B, and Nemotron 3.5 Bolt add
// an `optiq_vision` sidecar, and the Ornith 1.5 repos need OptiQ's `import optiq` registration, which stock
// mlx-lm lacks, so an older or unconfigured oMLX may refuse them.
// `ornith-1-5-9b-mlx` and `mimo-v2-6-9b-mlx` are text-only (their repos carry no vision tower), unlike their Ollama
// rows. `ornith-9b-mlx` and `ornith-35b-mlx` are the reverse: their repos carry a vision tower that the text-only
// Ollama builds lack, so they are flagged vision. ctxK is each repo's own `max_position_embeddings` where it is
// lower than the Ollama row's (Bolt: 64K, not 128K).
// Real mlx-community repos still without a row, on purpose: the older models (Llama 4, Command A, Qwen3-Coder,
// Qwen3-VL 32B, Qwen2.5-Coder, Devstral, Codestral, DeepCoder, Gemma 3, Mistral Small 22B, Nemotron 3 33B,
// DeepSeek-Coder-V2 236B), kept out so this pass stays on 2026 releases; LFM2.5-8B-A1B, whose Ollama row's
// reason flag is stale (the vendor calls it a reasoning model) and should be settled with its row first; and
// Mistral Medium 3.5, whose repo (2026-04-29) still carries the pre-fix rope config (`mscale_all_dim` 1.0; the
// vendor set 0.0 on 2026-05-01 after long-context degradation) — the Ollama GGUF has the fixed value.
const VLLM_MLX_LLM_TOON = `
llms[76|]{id,backendModelId,name,purpose,params,gb,tier,ctxK,creator,intel,reason,vision,tools,audio,tps,ttft,e2e,quant}:
  llama3-2-3b-mlx|mlx-community/Llama-3.2-3B-Instruct-4bit|Llama 3.2 3B (MLX)|general|3|1.8|low||Meta||0|0|1|0||||mlx-4bit
  qwen3-8b-mlx|mlx-community/Qwen3-8B-4bit|Qwen 3 8B (MLX)|general|8|4.6|low|40|Alibaba||1|0|1|0||||mlx-4bit
  gpt-oss-20b-mlx|mlx-community/gpt-oss-20b-MXFP4-Q8|GPT-OSS 20B (MLX)|general|20|12.1|medium|131|OpenAI||1|0|1|0||||mxfp4
  qwen3-8-27b-mlx|mlx-community/Qwen3.8-27B-4bit|Qwen 3.8 27B (MLX)|reasoning|27|16.1|medium|256|Alibaba||1|1|1|0||||mlx-4bit
  qwen3-30b-a3b-mlx|mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit|Qwen 3 30B A3B (MLX)|general|30|17.2|medium|256|Alibaba||1|0|1|0||||mlx-4bit
  llama3-3-70b-mlx|mlx-community/Llama-3.3-70B-Instruct-4bit|Llama 3.3 70B (MLX)|general|70|39.7|high|128|Meta||0|0|1|0||||mlx-4bit
  gemma4-e4b-mlx|mlx-community/gemma-4-e4b-it-4bit|Gemma 4 E4B (MLX)|general|4|5.2|cpu-only|128|Google||1|1|1|1||||mlx-4bit
  gemma4-26b-mlx|mlx-community/gemma-4-26b-a4b-it-4bit|Gemma 4 26B (MLX)|general|26|15.4|medium|256|Google||1|1|1|0||||mlx-4bit
  gemma4-31b-mlx|mlx-community/gemma-4-31b-it-4bit|Gemma 4 31B (MLX)|general|31|18.4|medium|256|Google||1|1|1|0||||mlx-4bit
  muse-glimmer-mlx|mlx-community/Muse-Glimmer-30B-4bit|Muse Glimmer (MLX)|general|30|19.4|medium|128|Meta||1|1|1|0||||mlx-4bit
  qwen3-6-27b-mlx|mlx-community/Qwen3.6-27B-4bit|Qwen 3.6 27B (MLX)|coding|27|16.1|medium|262|Alibaba||1|1|1|0||||mlx-4bit
  qwen3-6-35b-mlx|mlx-community/Qwen3.6-35B-A3B-4bit|Qwen 3.6 35B (MLX)|coding|35|20.4|medium|262|Alibaba||1|1|1|0||||mlx-4bit
  qwen3-5-0-8b-mlx|mlx-community/Qwen3.5-0.8B-MLX-4bit|Qwen 3.5 0.8B (MLX)|reasoning|0.8|0.7|cpu-only|262|Alibaba||1|1|1|0||||mlx-4bit
  qwen3-5-2b-mlx|mlx-community/Qwen3.5-2B-MLX-4bit|Qwen 3.5 2B (MLX)|reasoning|2|1.7|cpu-only|262|Alibaba||1|1|1|0||||mlx-4bit
  qwen3-5-4b-mlx|mlx-community/Qwen3.5-4B-MLX-4bit|Qwen 3.5 4B (MLX)|reasoning|4|3.1|cpu-only|262|Alibaba||1|1|1|0||||mlx-4bit
  qwen3-5-9b-mlx|mlx-community/Qwen3.5-9B-MLX-4bit|Qwen 3.5 9B (MLX)|reasoning|9|6.0|low|262|Alibaba||1|1|1|0||||mlx-4bit
  qwen3-5-27b-mlx|mlx-community/Qwen3.5-27B-4bit|Qwen 3.5 27B (MLX)|reasoning|27|16.1|medium|262|Alibaba||1|1|1|0||||mlx-4bit
  qwen3-5-35b-mlx|mlx-community/Qwen3.5-35B-A3B-4bit|Qwen 3.5 35B A3B (MLX)|reasoning|35|20.4|medium|262|Alibaba||1|1|1|0||||mlx-4bit
  qwen3-5-122b-mlx|mlx-community/Qwen3.5-122B-A10B-4bit|Qwen 3.5 122B A10B (MLX)|reasoning|122|69.6|high|262|Alibaba||1|1|1|0||||mlx-4bit
  nemotron-3-nano-4b-mlx|mlx-community/NVIDIA-Nemotron-3-Nano-4B-4bit|Nemotron 3 Nano 4B (MLX)|reasoning|4|2.3|cpu-only|262|NVIDIA||1|0|1|0||||mlx-4bit
  nemotron-3-nano-30b-mlx|mlx-community/NVIDIA-Nemotron-3-Nano-30B-A3B-4bit|Nemotron 3 Nano 30B (MLX)|reasoning|30|17.8|medium|1000|NVIDIA||1|0|1|0||||mlx-4bit
  nemotron-3-super-120b-mlx|mlx-community/NVIDIA-Nemotron-3-Super-120B-A12B-4bit|Nemotron 3 Super 120B (MLX)|reasoning|120|68.0|high|256|NVIDIA||1|0|1|0||||mlx-4bit
  gpt-oss-120b-mlx|mlx-community/gpt-oss-120b-MXFP4-Q8|GPT-OSS 120B (MLX)|general|120|63.4|high|131|OpenAI||1|0|1|0||||mxfp4
  deepseek-r1-1-5b-mlx|mlx-community/DeepSeek-R1-Distill-Qwen-1.5B-4bit|DeepSeek R1 1.5B (MLX)|reasoning|1.5|1.0|cpu-only||DeepSeek||1|0|1|0||||mlx-4bit
  deepseek-r1-7b-mlx|mlx-community/DeepSeek-R1-Distill-Qwen-7B-4bit|DeepSeek R1 7B (MLX)|reasoning|7|4.3|low||DeepSeek||1|0|1|0||||mlx-4bit
  deepseek-r1-8b-mlx|mlx-community/DeepSeek-R1-Distill-Llama-8B-4bit|DeepSeek R1 8B (MLX)|reasoning|8|4.5|low||DeepSeek||1|0|1|0||||mlx-4bit
  deepseek-r1-14b-mlx|mlx-community/DeepSeek-R1-Distill-Qwen-14B-4bit|DeepSeek R1 14B (MLX)|reasoning|14|8.3|low||DeepSeek||1|0|1|0||||mlx-4bit
  deepseek-r1-32b-mlx|mlx-community/DeepSeek-R1-Distill-Qwen-32B-4bit|DeepSeek R1 32B (MLX)|reasoning|32|18.4|medium||DeepSeek||1|0|1|0||||mlx-4bit
  deepseek-r1-70b-mlx|mlx-community/DeepSeek-R1-Distill-Llama-70B-4bit|DeepSeek R1 70B (MLX)|reasoning|70|39.7|high||DeepSeek||1|0|1|0||||mlx-4bit
  deepseek-r1-671b-mlx|mlx-community/DeepSeek-R1-4bit|DeepSeek R1 671B (MLX)|reasoning|671|419.5|high|160|DeepSeek||1|0|1|0||||mlx-4bit
  deepseek-coder-v2-16b-mlx|mlx-community/DeepSeek-Coder-V2-Lite-Instruct-4bit|DeepSeek Coder V2 16B (MLX)|coding|16|8.8|medium|160|DeepSeek||0|0|0|0||||mlx-4bit
  qwen3-1-7b-mlx|mlx-community/Qwen3-1.7B-4bit|Qwen 3 1.7B (MLX)|general|1.7|1.0|cpu-only|40|Alibaba||1|0|1|0||||mlx-4bit
  qwen3-4b-mlx|mlx-community/Qwen3-4B-4bit|Qwen 3 4B (MLX)|general|4|2.3|cpu-only|256|Alibaba||1|0|1|0||||mlx-4bit
  qwen3-14b-mlx|mlx-community/Qwen3-14B-4bit|Qwen 3 14B (MLX)|general|14|8.3|low|40|Alibaba||1|0|1|0||||mlx-4bit
  qwen3-32b-mlx|mlx-community/Qwen3-32B-4bit|Qwen 3 32B (MLX)|general|32|18.4|medium|40|Alibaba||1|0|1|0||||mlx-4bit
  qwen3-235b-mlx|mlx-community/Qwen3-235B-A22B-4bit|Qwen 3 235B A22B (MLX)|general|235|132.3|high|256|Alibaba||1|0|1|0||||mlx-4bit
  qwq-32b-mlx|mlx-community/QwQ-32B-4bit|QwQ 32B (MLX)|reasoning|32|18.4|medium|40|Alibaba||1|0|1|0||||mlx-4bit
  gemma3-270m-mlx|mlx-community/gemma-3-270m-it-4bit|Gemma 3 270M (MLX)|general|0.27|0.2|cpu-only|32|Google||0|0|0|0||||mlx-4bit
  mistral-7b-mlx|mlx-community/Mistral-7B-Instruct-v0.3-4bit|Mistral 7B (MLX)|general|7|4.1|low|32|Mistral||0|0|1|0||||mlx-4bit
  mistral-nemo-12b-mlx|mlx-community/Mistral-Nemo-Instruct-2407-4bit|Mistral Nemo 12B (MLX)|general|12|6.9|low||Mistral||0|0|1|0||||mlx-4bit
  mistral-small-24b-mlx|mlx-community/Mistral-Small-24B-Instruct-2501-4bit|Mistral Small 24B (MLX)|general|24|13.3|medium|32|Mistral||0|0|1|0||||mlx-4bit
  mistral-large-123b-mlx|mlx-community/Mistral-Large-Instruct-2407-4bit|Mistral Large 123B (MLX)|general|123|69.0|high||Mistral||0|0|1|0||||mlx-4bit
  mixtral-8x7b-mlx|mlx-community/Mixtral-8x7B-Instruct-v0.1-4bit|Mixtral 8X7B (MLX)|general|47|26.3|high|32|Mistral||0|0|1|0||||mlx-4bit
  mixtral-8x22b-mlx|mlx-community/Mixtral-8x22B-4bit|Mixtral 8X22B (MLX)|general|141|79.4|high|64|Mistral||0|0|1|0||||mlx-4bit
  llama3-2-1b-mlx|mlx-community/Llama-3.2-1B-Instruct-4bit|Llama 3.2 1B (MLX)|general|1|0.7|cpu-only||Meta||0|0|1|0||||mlx-4bit
  llama3-1-8b-mlx|mlx-community/Meta-Llama-3.1-8B-Instruct-4bit|Llama 3.1 8B (MLX)|general|8|4.5|low||Meta||0|0|1|0||||mlx-4bit
  llama3-1-70b-mlx|mlx-community/Meta-Llama-3.1-70B-Instruct-4bit|Llama 3.1 70B (MLX)|general|70|39.7|high||Meta||0|0|1|0||||mlx-4bit
  llama3-1-405b-mlx|mlx-community/Meta-Llama-3.1-405B-4bit|Llama 3.1 405B (MLX)|general|405|230.7|high|128|Meta||0|0|1|0||||mlx-4bit
  glm4-9b-mlx|mlx-community/glm-4-9b-chat-1m-4bit|GLM-4 9B (MLX)|general|9|5.4|low||Z AI||0|0|1|0||||mlx-4bit
  glm-5-2-mlx|mlx-community/GLM-5.2-4bit|GLM 5.2 (MLX)|reasoning|754|418.3|high|1000|Z AI||1|0|1|0||||mlx-4bit
  glm-4-7-flash-30b-mlx|mlx-community/GLM-4.7-Flash-4bit|GLM-4.7 Flash (MLX)|reasoning|30|16.9|medium|200|Z AI||1|0|1|0||||mlx-4bit
  nemotron-3-5-lightning-30b-mlx|mlx-community/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-4bit|Nemotron 3.5 Lightning (MLX)|general|30|17.8|medium|1000|NVIDIA||0|0|1|0||||mlx-4bit
  deepseek-v4-flash-0731-mlx|mlx-community/DeepSeek-V4-Flash-0731-2.4bit-mixed|DeepSeek V4 Flash 0731 (MLX)|reasoning|284|92.8|high|1000|DeepSeek||1|0|1|0||||mlx-2.4bit
  ministral-3-3b-mlx|mlx-community/Ministral-3-3B-Instruct-2512-4bit|Ministral 3 3B (MLX)|general|3|2.8|cpu-only|256|Mistral||0|1|1|0||||mlx-4bit
  ministral-3-8b-mlx|mlx-community/Ministral-3-8B-Instruct-2512-4bit|Ministral 3 8B (MLX)|general|8|5.6|low|256|Mistral||0|1|1|0||||mlx-4bit
  ministral-3-14b-mlx|mlx-community/Ministral-3-14B-Instruct-2512-4bit|Ministral 3 14B (MLX)|general|14|8.5|low|256|Mistral||0|1|1|0||||mlx-4bit
  command-r-35b-mlx|mlx-community/c4ai-command-r-v01-4bit|Command R 35B (MLX)|general|35|22.7|medium|128|Cohere||0|0|1|0||||mlx-4bit
  north-mini-code-1-0-mlx|mlx-community/North-Mini-Code-1.0-4bit|North Mini Code 1.0 (MLX)|coding|30|18.5|medium|488|Cohere||1|0|1|0||||mlx-4bit
  olmo-3-7b-mlx|mlx-community/Olmo-3-7B-Instruct-4bit|OLMo 3 7B (MLX)|general|7|4.1|low|64|Allen Institute||0|0|1|0||||mlx-4bit
  olmo-3-32b-mlx|mlx-community/Olmo-3-1125-32B-8bit|OLMo 3 32B (MLX)|general|32|34.3|medium|64|Allen Institute||0|0|1|0||||mlx-8bit
  phi4-14b-mlx|mlx-community/phi-4-4bit|Phi-4 14B (MLX)|general|14|8.3|low|16|Microsoft||0|0|1|0||||mlx-4bit
  phi4-mini-3-8b-mlx|mlx-community/Phi-4-mini-instruct-4bit|Phi-4 Mini 3.8B (MLX)|general|3.8|2.2|cpu-only|128|Microsoft||0|0|1|0||||mlx-4bit
  phi4-reasoning-14b-mlx|mlx-community/Phi-4-reasoning-4bit|Phi-4 Reasoning 14B (MLX)|reasoning|14|8.3|low|32|Microsoft||1|0|1|0||||mlx-4bit
  minimax-m2-mlx|mlx-community/MiniMax-M2-4bit|MiniMax M2 (MLX)|general|230|128.7|high|205|MiniMax||1|0|1|0||||mlx-4bit
  laguna-s-2-1-mlx|mlx-community/Laguna-S-2.1-oQ4e|Laguna S 2.1 (MLX)|coding|118|64.1|high|256|Poolside||1|0|1|0||||mlx-4bit
  ornith-9b-mlx|mlx-community/Ornith-1.0-9B-4bit|Ornith 9B (MLX)|coding|9|6.0|low|256|Deep Reinforce||1|1|1|0||||mlx-4bit
  ornith-35b-mlx|mlx-community/Ornith-1.0-35B-4bit|Ornith 35B (MLX)|coding|35|20.4|medium|256|Deep Reinforce||1|1|1|0||||mlx-4bit
  ornith-1-5-9b-mlx|mlx-community/Ornith-1.5-9B-OptiQ-4bit|Ornith 1.5 9B (MLX)|coding|9|7.1|low|256|Deep Reinforce||1|0|1|0||||mlx-4bit
  ornith-1-5-35b-mlx|mlx-community/Ornith-1.5-35B-A3B-OptiQ-4bit|Ornith 1.5 35B (MLX)|coding|35|23.5|medium|256|Deep Reinforce||1|1|1|0||||mlx-4bit
  mimo-v2-6-9b-mlx|mlx-community/MiMo-V2.6-Distill-Qwen-9B-OptiQ-4bit|MiMo-V2.6 9B (MLX)|coding|9|7.1|low|256|Xiaomi||1|0|1|0||||mlx-4bit
  flint-40b-mlx|mlx-community/flint-oQ4e|Flint 40B (MLX)|coding|39.8|23.4|medium|256|Recursive||1|0|1|0||||mlx-4bit
  nemotron-3-5-bolt-e4b-mlx|mlx-community/NVIDIA-Nemotron-3.5-Bolt-E4B-OptiQ-4bit|Nemotron 3.5 Bolt E4B (MLX)|reasoning|4|7.5|low|64|NVIDIA||1|1|1|0||||mlx-4bit
  lfm3-1-7b-mlx|mlx-community/LFM3-1.7B-OptiQ-4bit|LFM3 1.7B (MLX)|general|1.7|1.3|cpu-only|256|Liquid AI||1|0|1|0||||mlx-4bit
  lfm3-vl-2b-mlx|mlx-community/LFM3-VL-2B-OptiQ-4bit|LFM3 VL 2B (MLX)|general|1.92|1.7|cpu-only|128|Liquid AI||1|1|1|0||||mlx-4bit
  lfm2-5-24b-mlx|mlx-community/LFM2.5-24B-A2B-OptiQ-4bit|LFM 2.5 24B (MLX)|reasoning|24|16.7|medium|128|Liquid AI||1|0|1|0||||mlx-4bit
  qwen3-8-flash-next-125b-mlx|mlx-community/Qwen3.8-Flash-Next-4bit|Qwen 3.8 Flash Next 125B A6B (MLX)|reasoning|125|111.5|high|256|Alibaba||1|1|1|0||||mlx-4bit
`;

const omlxLlms: CuratedModel[] = decodeToonTable(VLLM_MLX_LLM_TOON, 'llms').map((row) =>
  buildLlmModel(row, 'omlx', { gpuVendors: ['apple'], supportedPlatforms: ['darwin'] }),
);

// Non-LLM models (voice + embedding) in TOON. Unlike the LLM table these carry explicit requirements
// (they aren't derived from a parameter count); purpose and input modality are derived from `modality`.
// Voice models run on the Lemonade backend; embedders on Ollama. cpu=1 means CPU inference is supported.
//
// 2026-09-29: the Lemonade embedder is nomic-embed-text v1.5, not the v1 in Lemonade's own registry.
// Every install embeds with the same model, whichever engine runs it, so switching engines never
// strands an index. Measured on the 7900 XTX: Ollama's `nomic-embed-text` and Lemonade serving
// nomic-ai/nomic-embed-text-v1.5-GGUF (F16) agree at cosine 0.99996–0.99998 on the same text; Lemonade's
// built-in v1 agrees at 0.69–0.73, i.e. a different vector space. Lemonade does not ship v1.5, so the
// Hub registers it on pull (`LEMONADE_REGISTRATIONS` in lemonade.backend.ts). lemonade-server 2026.39.1
// then lists it as `nomic-embed-text-v1.5-GGUF`, but 10.2.0 (the fleet's apt package) lists and serves
// it only as `user.nomic-embed-text-v1.5-GGUF`; the Hub hands out whichever spelling the server lists.
//
// Later on 2026-09-29: the v1 row is back, as `available` and never recommended. Until #1679 it was the
// Lemonade default, so a Lemonade-only host that installed before then holds an index of v1 vectors; both
// models are 768-dim, so pgvector would take v1.5 vectors into that index without complaint and search
// would quietly degrade. The embedder handout keeps such a host on v1 (it has v1 downloaded and not
// v1.5) until the operator chooses otherwise, and a preference or tracked state naming the v1 row
// resolves again. Switching needs a re-embed; see docs/MODEL_REGISTRY.md.
//
// Also later on 2026-09-29: the two Whisper rows name Lemonade's registry keys, `Whisper-Large-v3-Turbo` and
// `Whisper-Base` (the same in 10.2.0 and 2026.39.1). Lemonade looks names up case-sensitively, so the
// lowercase ids these rows carried were never servable, and the registry filter now hides a row the
// connected Lemonade does not list.
const EXTRAS_TOON = `
extras[9|]{id,backendModelId,backend,modality,name,creator,diskMb,footprintMb,minRamMb,recVramMb,minVramMb,ctx,minTier,cpu,pinned,tierHigh,tierMed,tierLow,tierCpu,desc}:
  kokoro-v1|kokoro-v1|lemonade|tts|Kokoro v1 TTS|Hexgrad|300|350|1024|512|0|0|cpu-only|1|1|recommended|recommended|recommended|recommended|High-quality text-to-speech. Low latency, natural sounding.
  whisper-large-v3-turbo|Whisper-Large-v3-Turbo|lemonade|stt|Whisper Large v3 Turbo|OpenAI|1500|1500|8192|6144|4096|0|medium|0|0|recommended|recommended|not-recommended|not-recommended|OpenAI's speech-to-text model. Fast and accurate transcription.
  whisper-base|Whisper-Base|lemonade|stt|Whisper Base|OpenAI|150|200|1024|512|0|0|cpu-only|1|0|available|available|recommended|recommended|Lightweight speech-to-text for resource-constrained environments.
  nomic-embed-text|nomic-embed-text|ollama|embedding|Nomic Embed Text|Nomic|300|500|1024|512|0|8192|cpu-only|1|1|recommended|recommended|recommended|recommended|Local text-embedding model (768-dim). Default embeddings for CI memory / RAG (pgvector). Runs on any hardware.
  embeddinggemma|embeddinggemma|ollama|embedding|EmbeddingGemma|Google|622|700|1536|1024|0|2048|cpu-only|1|0|available|available|available|available|Google's 300M embedding model (768-dim, Matryoshka-truncatable to 512/256/128). Multilingual (100+ languages), 2K context. Drop-in pgvector replacement for Nomic at the same 768 dimensions, with stronger retrieval. Runs on any hardware.
  nomic-embed-text-v2-moe|nomic-embed-text-v2-moe|ollama|embedding|Nomic Embed Text v2 (MoE)|Nomic|900|900|2048|1024|0|512|cpu-only|1|0|available|available|available|available|Nomic Embed v2, a mixture-of-experts embedding model (~305M active / 475M total params, 768-dim). Multilingual (~100 languages) and pgvector-compatible with the 768-dim Nomic default. Runs on any hardware.
  qwen3-embedding|qwen3-embedding|ollama|embedding|Qwen3 Embedding (0.6B)|Alibaba|640|800|2048|1536|0|32768|cpu-only|1|0|available|available|available|available|Qwen3 Embedding 0.6B (1024-dim, 32K context). Tops the multilingual MTEB leaderboard for its size across 100+ languages. Note: 1024-dim — switching from the 768-dim default requires re-embedding existing memories. Runs on any hardware.
  nomic-embed-text-v1-5-lemonade|nomic-embed-text-v1.5-GGUF|lemonade|embedding|Nomic Embed Text v1.5 (Lemonade)|Nomic|262|300|1024|512|0|8192|cpu-only|1|0|recommended|recommended|recommended|recommended|Local text-embedding model (768-dim) served through Lemonade, for hosts running Lemonade as their only local backend. The same F16 weights as Ollama's nomic-embed-text, so either engine's vectors search the other's index. Runs on any hardware.
  nomic-embed-text-v1-lemonade|nomic-embed-text-v1-GGUF|lemonade|embedding|Nomic Embed Text v1 (Lemonade)|Nomic|80|150|1024|512|0|8192|cpu-only|1|0|available|available|available|available|Lemonade's built-in embedder (768-dim), the Hub's Lemonade default until 2026-09-29. Kept for hosts whose stored vectors came from it: its vectors do not match v1.5 or Ollama's nomic-embed-text, so switching away needs a re-embed. Runs on any hardware.
`;

const tierRec = (rec: string | undefined): TierRecommendation => (rec === 'recommended' || rec === 'not-recommended' ? rec : 'available');

const extraModels: CuratedModel[] = decodeToonTable(EXTRAS_TOON, 'extras').map((row): CuratedModel => {
  const modality = (row.modality ?? 'embedding') as ModelModality;
  const purpose: ModelPurpose = modality === 'tts' ? 'voice' : modality === 'stt' ? 'transcription' : 'embedding';
  const input: ('text' | 'image' | 'audio')[] = modality === 'stt' ? ['audio'] : ['text'];
  const audio = modality === 'stt';
  const gpuVendors: ('nvidia' | 'amd' | 'apple' | 'cpu')[] = flag(row.cpu) ? ['nvidia', 'amd', 'apple', 'cpu'] : ['nvidia', 'amd', 'apple'];
  return {
    id: row.id ?? '',
    backend: (row.backend ?? 'ollama') as InferenceBackendType,
    backendModelId: row.backendModelId ?? '',
    modality,
    purpose,
    displayName: row.name ?? '',
    description: row.desc ?? '',
    requirements: {
      minVramMb: Number(row.minVramMb),
      recommendedVramMb: Number(row.recVramMb),
      minRamMb: Number(row.minRamMb),
      diskMb: Number(row.diskMb),
      gpuVendors,
      supportedPlatforms: defaultSupportedPlatforms((row.backend ?? 'ollama') as InferenceBackendType),
      npuRequired: false,
      minTier: (row.minTier ?? 'cpu-only') as HardwareTier,
    },
    runtime: {
      contextWindow: Number(row.ctx),
      maxTokens: 0,
      reasoning: false,
      input,
      pinnedByDefault: flag(row.pinned),
      memoryFootprintMb: Number(row.footprintMb),
    },
    tiers: { high: tierRec(row.tierHigh), medium: tierRec(row.tierMed), low: tierRec(row.tierLow), cpuOnly: tierRec(row.tierCpu) },
    metadata: { creator: row.creator || undefined, capabilities: { reasoning: false, vision: false, tools: false, audio } },
  };
});

/**
 * Context memory per token, measured on the engine, for models whose engine cannot size it. Lemonade
 * exposes no geometry at all, so without this its models fall to the context ladder's 0.25 MB/token
 * — dense-model arithmetic, four times what a hybrid-attention model costs.
 *
 * Qwen 3.8 27B, measured 2026-09-29 on a 7900 XTX: Lemonade used 19,017 MiB at 8192 tokens and
 * 20,657 MiB at 32768, 0.0667 MiB/token (llama.cpp logs 512 MiB of KV at 8192 = 0.0625, plus the
 * MTP draft context's own KV). The Ollama rows run the same weights; without MTP it is the 0.0625.
 * The same load, less its KV at 8192, is the Lemonade row's measured `ramGb`; its model and mmproj
 * files came to 17,630 MiB, against the registry's 18.8 GB that the row's `gb` carries.
 */
const MEASURED_KV_MB_PER_TOKEN: Record<string, number> = {
  'qwen3-8-27b': 0.0625,
  'qwen3-8-27b-mtp': 0.0667,
  'qwen3-8-27b-lemonade': 0.0667,
};

/**
 * Rows measured to run with an 8-bit KV cache (see `CuratedModel.runtime.kvCacheType`).
 *
 * Qwen 3.8 27B on Lemonade 2026.45.3, measured 2026-11-10 on a 7900 XTX (ROCm, llama.cpp b11836, MTP
 * draft on): 22.01 GiB in use at 32768 with the 16-bit cache, 22.50 GiB at 65536 with
 * `-fa on --cache-type-k q8_0 --cache-type-v q8_0`. Prompt 924 vs 937 tok/s, generation 63.8 vs 64.8
 * tok/s, the same greedy answer word for word, and a 55,812-token prompt recalled 4 of 4 facts placed
 * through it. Hermes needs 64000, which the 16-bit cache cannot give on that card. Only the Lemonade
 * row: the Hub sets a Lemonade model's cache type per model, while Ollama's is the server-wide
 * `OLLAMA_KV_CACHE_TYPE`, a provisioning setting the Hub does not read.
 */
const MEASURED_KV_CACHE_TYPE: Record<string, NonNullable<CuratedModel['runtime']['kvCacheType']>> = {
  'qwen3-8-27b-lemonade': 'q8_0',
};

function withMeasuredKv(model: CuratedModel): CuratedModel {
  const kvMbPerToken = MEASURED_KV_MB_PER_TOKEN[model.id];
  const kvCacheType = MEASURED_KV_CACHE_TYPE[model.id];
  if (kvMbPerToken === undefined && kvCacheType === undefined) return model;
  return {
    ...model,
    runtime: {
      ...model.runtime,
      ...(kvMbPerToken !== undefined && { kvMbPerToken }),
      ...(kvCacheType !== undefined && { kvCacheType }),
    },
  };
}

/**
 * A Lemonade or Ollama row whose footprint was not measured is charged its files plus the runner's fixed
 * overhead (`kv-geometry.generated.ts`, from Hugging Face and Ollama's registry), not the TOON's download
 * size plus 10 % — the same base the sizing charges once the files are on disk (`weightMb` + 768). Its
 * download size becomes the files' too: five rows were more than 10 % off (gemma4:e2b's tag shrank from
 * 7,373 to 4,375 MiB). Qwen 3.8
 * 27B's files are 17,630 MiB, which with the 768 MB overhead is 18,398 against the 18,473 measured; the
 * 10 % rule put the same-size Qwen 3.5 27B at 20,838, and with its context that left it 16k on a 24 GB
 * card that holds 32k. The KV cost from the same table is applied where the cost is probed
 * (`probeContextCost`), not here, so a measured `kvMbPerToken` stays distinguishable from a computed one.
 */
function withFileFootprint(row: CuratedModel): CuratedModel {
  if (row.backend !== 'lemonade' && row.backend !== 'ollama') return row;
  const model = withFileWindow(row);
  const fileBytes = GGUF_KV_GEOMETRY[model.id]?.fileBytes;
  if (!fileBytes || fileBytes <= 0) return model;
  // A measured footprint stays: only its download size, a fact about the files, is taken from them.
  if (model.runtime.footprintMeasured) return { ...model, requirements: { ...model.requirements, diskMb: Math.round(fileBytes / 1024 ** 2) } };
  // The requirements the TOON derives from its download size are derived from the files instead, by the
  // same expressions (buildLlmModel), so the download gate's weights floor (`weightsFloorMb`, from
  // `diskMb`) stays at or under the footprint.
  const diskMb = Math.round(fileBytes / 1024 ** 2);
  const footprintMb = Math.ceil(fileBytes / 1024 ** 2 + FIXED_RUNNER_OVERHEAD_MB);
  return {
    ...model,
    requirements: { ...model.requirements, diskMb, minVramMb: diskMb, recommendedVramMb: footprintMb + 1024, minRamMb: Math.round(diskMb * 1.15) },
    runtime: { ...model.runtime, memoryFootprintMb: footprintMb },
  };
}

/**
 * A row's window capped at its file's `context_length`, the most it runs at as configured. The TOON's
 * ctxK is the model card's figure, which for some families is reached only with rope scaling neither
 * engine switches on: Lemonade's Qwen3-8B said 131072 and its file 40960, and Lemonade refused every
 * 58k-token prompt to it (2026-11-10), while the Hub would have handed an app 64k.
 */
function withFileWindow(model: CuratedModel): CuratedModel {
  const fileWindow = GGUF_KV_GEOMETRY[model.id]?.contextLength;
  if (!fileWindow || !(model.runtime.contextWindow > fileWindow)) return model;
  return { ...model, runtime: { ...model.runtime, contextWindow: fileWindow } };
}

export const CURATED_MODELS: CuratedModel[] = [...generatedLlms, ...lemonadeLlms, ...vllmLlms, ...omlxLlms, ...extraModels]
  .map(withMeasuredKv)
  .map(withFileFootprint);
