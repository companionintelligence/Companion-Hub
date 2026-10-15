# Inference engine comparison: Hub engines, Halogen, and Gufo

This note compares the four inference engines the Hub supports (Ollama, vLLM, Lemonade, oMLX) with two
Strix Halo engines that are not integrated: [halogen-flash-server](https://github.com/peonist-ai/halogen-flash-server)
and [gufo](https://github.com/gufo-org/gufo). It was researched on 2026-10-04 from each project's README,
license, issue tracker, and GitHub metadata, and from the Hub's own backend code. **No benchmark was run
for this note.** Every speed figure is either a project's own claim or an earlier Hub fleet measurement,
and the two kinds are not comparable (see [Reading the speed numbers](#reading-the-speed-numbers)).

## Summary

- **Neither candidate is a drop-in fifth backend.** Both run on one GPU architecture (Strix Halo,
  `gfx1151`) and serve one model per process. The Hub's `vllm` adapter has the same shape today: the model
  is fixed when the process starts, `loadModel` only logs, and there is no residency report.
- **Halogen fits a shared appliance worst.** It is a closed-source binary for one model, pins about 62 to
  68 GiB of weights, takes about 74 to 89 GiB of a 128 GiB machine, and tells you to
  [give it a machine of its own](https://github.com/peonist-ai/halogen-flash-server#give-it-a-machine-of-its-own).
  It also wants the BIOS graphics carve-out at its minimum, which is the opposite of what the other
  engines on this hardware want.
- **Gufo is the better candidate to try.** It is MIT licensed, serves several model families (LLM, speech
  recognition, speech synthesis, image), and takes ordinary GGUF files. It is also pre-1.0 and moving
  daily, has no `/v1/embeddings`, and has open `gfx1151` and co-tenancy bugs ([Known issues](#known-issues-in-the-candidates)).
- **Both need ROCm.** Hub fleet nodes with Strix Halo run Ollama on Vulkan, which measured about 30%
  faster than ROCm there for `qwen3.6:27b` (core-1, 2026-09-06). Neither candidate has a Vulkan path.
- **The speed claims are plausible but unproven for the Hub.** A fair test needs the same node, the same
  model, and paired per-prompt ratios ([What a fair test needs](#what-a-fair-test-needs)).

## How to read the tables

| Mark | Meaning |
|------|---------|
| plain text | Read from the Hub code or the project's own README or license during this research |
| (claimed) | A project's own figure, not reproduced here |
| (fleet) | Measured on the Hub fleet in an earlier session, not re-measured here |
| ✔ / ✘ | Supported / not supported |

## Engine facts

| | Ollama | vLLM | Lemonade | oMLX | Halogen | Gufo |
|---|---|---|---|---|---|---|
| **What it is** | General local runtime built on llama.cpp (Go) | Python serving engine with paged attention | AMD-backed local AI server that fronts llama.cpp, whisper.cpp, and other recipes (C++) | MLX server for Apple Silicon (Python) | Closed-source engine, hand-written kernels for one model | Open C++20/HIP engine, kernels per model family |
| **License** | MIT | Apache-2.0 | Apache-2.0 | Apache-2.0 | Proprietary EULA v0.1: free commercial use, unmodified redistribution only, binary only, no telemetry | MIT for original code; adapted code keeps its own notices |
| **Hardware** | NVIDIA, AMD (ROCm, Vulkan fallback), Apple Silicon, CPU | NVIDIA in the Hub's Docker path. The Hub declines AMD (upstream ROCm image targets MI-series) and Apple in Docker | README lists Vulkan, ROCm, Metal, CUDA, CPU, and XDNA2 NPU recipes; platform varies by recipe | Apple Silicon, macOS 15 or later | Strix Halo `gfx1151` only; the build rejects other architectures. Optional XDNA NPU for small models | Strix Halo `gfx1151` only, Linux x86-64. A Windows port is a separate, unmerged fork |
| **Models served** | ollama.com library, GGUF import | Hugging Face checkpoints, one per process | GGUF, FLM, ONNX LLMs; whisper, Stable Diffusion, Kokoro | MLX checkpoints: LLMs, VLMs, OCR, embeddings, rerankers | Qwen3.8-Flash-Next only (native `.hgn`, or a llama.cpp GGUF of it) | LLM: Qwen3.8 27B, Qwen3.8 Flash-Next, DeepSeek V4 Flash. Also Qwen3-ASR, Qwen3-TTS, Qwen-Image-2.1, MiniMax H3. One `gufo serve <kind>` process per model |
| **API surface** | Native `/api/*` and OpenAI-compatible | OpenAI-compatible | OpenAI, Anthropic, and Ollama-compatible | OpenAI-compatible, admin UI | OpenAI chat, completions, responses, moderations; Anthropic `/v1/messages`; `/health`; Prometheus `/metrics` | OpenAI chat, responses, completions; Anthropic `/v1/messages` (text subset); `/health`, `/ready`, `/metrics`; `/infill` returns 501 |
| **Embeddings** | ✔ | ✔ (embedding models) | ✔ (the Hub loads its shared embedder here) | ✔ | NPU only (`qwen3-embedding-0.6b`; needs the XDNA driver and XRT) | ✘ `/v1/embeddings` returns 501 |
| **Install path** | Host daemon or container; the Hub can deploy it | Container (NVIDIA) or host | Package or container; the Hub can deploy it | Homebrew or `.dmg`; no Docker image | Container `ghcr.io/peonist-ai/halogen-flash-server`; first start downloads about 111 GiB | Container `ghcr.io/gufo-org/toolboxes/gufo-runtime`, or build with Nix or CMake (GCC 15.3, ROCm 7.2.3); weights fetched separately |
| **Stars, activity** | 182k, pushed daily | 93k, pushed daily | 5.8k, pushed daily | 22.5k, pushed daily | 840; repo created 2026-08-26; version 0.16.2; no GitHub releases; 16 open issues and PRs | 536; repo created 2026-08-11; v0.5.0, v0.6.0, v0.7.0 released 2026-10-02 to 10-04; 48 open issues and PRs |

## Behavior under the Hub's contract

| | Ollama | vLLM | Lemonade | oMLX | Halogen | Gufo |
|---|---|---|---|---|---|---|
| **In `INFERENCE_BACKEND_TYPES`** | ✔ | ✔ | ✔ | ✔ | ✘ | ✘ |
| **Hub deploys it** | ✔ Compose, ROCm or Vulkan image | NVIDIA only; AMD and Apple throw | ✔ Compose, AMD device groups | ✘ host only | ✘ | ✘ |
| **Hub pulls, loads, unloads** | ✔ real calls | ✘ log lines; model fixed at container start | ✔ real calls (`/v1/pull`, load, unload) | ✘ log lines; managed in oMLX's admin UI | n/a: one model, fixed at start | None found: one model per process |
| **Reports what is resident** | ✔ (`/api/ps`) | ✘ `unsupported` | ✔ (`/v1/health`) | ✘ not implemented | `/health` shows `in_flight` and `busy_for_s` only | `/ready` only |
| **Several models resident** | ✔ | ✘ | ✔ | ✔ LRU eviction, pinning | ✘ | ✘ per process; you would run one process per model, each pinning its own weights |
| **Concurrency** | Operator states slots (`OLLAMA_NUM_PARALLEL`) | Continuous batching | llama-server slots | Continuous batching, tiered SSD KV cache | 4 KV slots by default, up to 64; no preemption or paging | `--sessions N` (default 1); batches ready requests; DeepSeek up to 8 |
| **Speculative decoding** | Model's own MTP head, Ollama 0.30.8 or later, per-request `draft_num_predict` (undocumented) | `--speculative-config` at launch | `--spec-type draft-simple` through `llamacpp_args` on load | Not offered by the Hub | Draft head plus prompt lookup; only while one stream is generating | DFlash2 (27B), MTP (Flash-Next), DSpark (DeepSeek) |
| **Pool member** | ✔ | ✔ | ✔ | ✔ | ✘ | ✘ |
| **Model source** | ollama.com library, verified by the catalog tests | Hugging Face | Lemonade registry plus Hugging Face `user.*` | `mlx-community` on Hugging Face | Own Hugging Face repo, about 111 GiB | Hugging Face GGUF (Unsloth) plus draft or MTP side files |
| **Shares the machine** | ✔ evicts on `keep_alive`; the Hub's memory manager budgets it | Preallocates GPU memory at start | ✔ | ✔ | ✘ takes about 74 to 89 GiB of 128; stalls and wedges under host memory pressure ([issue #85](https://github.com/peonist-ai/halogen-flash-server/issues/85)) | Not stated in the README. Auto cache budget can exhaust the KFD limit with other models resident ([issue #387](https://github.com/gufo-org/gufo/issues/387)) |

## Reported speed

These rows use different models, quantizations, prompts, and power limits. Do not compare them across rows.

| Source | Model and hardware | Prefill | Decode |
|---|---|---|---|
| Halogen (claimed) | Qwen3.8-Flash-Next, Strix Halo 128 GB, ROCm 7.14.0, about 85 W | 1,584 tok/s at 8,192 tokens; 1,567 at 32,768 | 37.6 tok/s serial greedy at 1,500 tokens of context; 46.0 with the draft head at 32,768; 55.7 to 56.3 on a coding-agent turn |
| Gufo (claimed) | Qwen3.8 Flash-Next Q4_K_XL, Strix Halo | 1,628.52 tok/s | Up to 59.41 tok/s single user with MTP; 157.22 tok/s aggregate at 8 users |
| Gufo (claimed) | Qwen3.8 27B Q4_K_XL, Strix Halo | 656.33 tok/s | Up to 70.56 tok/s single user with DFlash2; 123.00 aggregate at 8 users |
| Gufo (claimed) | DeepSeek V4 Flash IQ2XXS, Strix Halo | 484.62 tok/s | Up to 26.62 tok/s single user with DSpark; 54.74 aggregate at 8 users |
| Ollama (fleet, 2026-09-16) | `qwen3.6:27b`, Strix Halo GPU nodes, Vulkan | 157 to 312 tok/s | 10.7 to 11.9 tok/s |
| Ollama (fleet, 2026-09-30) | `qwen3.6:35b` and `qwen3-coder:30b` (mixture of experts), core-2, Vulkan | not measured | about 88 and 79 tok/s |
| Ollama (fleet, 2026-09-06) | `qwen3.6:27b` with spec decode, core-1, Vulkan | not measured | 2.0 to 2.7 times the plain decode rate |
| Ollama (catalog note, 2026-09-16) | `qwen3.8:27b` and its MTP variant, RX 7900 XTX (discrete, not Strix Halo), ROCm | not measured | 36 tok/s plain; 44 to 47 tok/s with MTP, depending on the prompt |

### Reading the speed numbers

- **Spec decode is prompt-dominated.** The Hub's own sweep found uplift of 1.57 to 3.65 times on code and
  no gain or a small slowdown on prose, on the same hardware. Gufo says its peaks include repetitive output, and Halogen's
  license text says its decode spans about 20 tok/s on prose to about 42 on code. A single tok/s figure
  without a named prompt set describes the prompt mix, not the engine.
- **Dense 27B decode is bandwidth bound on this chip.** As a back-of-envelope check, not a measurement:
  about 17 GB of Q4 weights read per token over roughly 256 GB/s of memory bandwidth gives a ceiling of
  about 15 tok/s without speculation, which matches the fleet's 11 tok/s. Gufo's 70 tok/s for the same
  model class therefore has to come almost entirely from speculation on repetitive text.
- **Flash-Next is a different workload.** It is a large mixture-of-experts model with few active
  parameters per token, so its decode rate says little about a dense 27B model.
- **The fleet found spec decode is not always output-lossless.** It was not on the lucebox and dflash
  builds tested (three nodes). Halogen and Gufo both claim lossless speculation; neither claim has been
  checked on the fleet.

## Known issues in the candidates

Read from each project's open issue list on 2026-10-04. Check the current state before you rely on any of
these.

**Gufo**

- [#414](https://github.com/gufo-org/gufo/issues/414): on `gfx1151`, prefill of 1,024 tokens or more
  aborts with `HSA_STATUS_ERROR_INVALID_ISA` in images 0.3.0 through 0.6.0. v0.7.0 shipped on 2026-10-04;
  whether it fixes this was not checked.
- [#387](https://github.com/gufo-org/gufo/issues/387): the automatic prompt-cache budget can exhaust the
  KFD memory limit on unified-memory machines when other models are resident.
- [#339](https://github.com/gufo-org/gufo/issues/339): chat completions rejects a system message that is
  not first, which breaks agents that inject context mid-conversation.
- [#349](https://github.com/gufo-org/gufo/issues/349): `--max-pending-per-client` defaults to 4, so one
  agent host is throttled at four concurrent requests. Every app behind the Hub proxy looks like one client.
- [#417](https://github.com/gufo-org/gufo/issues/417) and [#347](https://github.com/gufo-org/gufo/issues/347):
  `/v1/messages` lacks streaming and tools, and tool chunks in streaming need work.

**Halogen**

- [#85](https://github.com/peonist-ai/halogen-flash-server/issues/85): stalls and wedges under host
  memory pressure. This is the failure mode of sharing the machine.
- [#89](https://github.com/peonist-ai/halogen-flash-server/issues/89): the shipped checkpoint can predict
  an end-of-message token in the middle of prose past about 96k tokens of context.
- [#135](https://github.com/peonist-ai/halogen-flash-server/issues/135): the NPU path with
  `docker-compose.yml` is an open question.
- By design, there is no response store: `previous_response_id` and retrieval by id do not work, and
  cancellation is by client disconnect only. The README documents this; it is a limit, not a bug.

## What integrating one would take

Adding a fifth engine type is a compile-driven change: extend `INFERENCE_BACKEND_TYPES` in
`packages/common/src/types/inference.ts`, then follow the `Record<InferenceBackendType, …>` errors through
the registry, environment resolver, supervision, pool, and frontend. The 2026-09-21 session did this for
llama.cpp and LM Studio, and the 2026-09-28 consolidation removed those and three others (MTPLX,
mlx-dspark, Lucebox) to get from nine engines to four. A single-architecture engine that serves one model per process repeats that cost for the
few nodes it could serve.

The cheapest experiment needs no new type. The `vllm` adapter already has the right semantics (model fixed
at start, no residency report) and takes any URL. Its identity check
(`backends/engine-identity.ts`) only rejects a server whose `/v1/models` `owned_by` names a *different known
engine*, and leaves a server that does not name itself alone. Whether Gufo or Halogen names itself in
`owned_by` was not checked, so treat this as an untested option.

Two catalog constraints also apply:

- The catalog lists only models whose default `q4_K_M` tag exists on ollama.com. Gufo's Unsloth GGUFs and
  Halogen's `.hgn` checkpoint need a new source type.
- `qwen3.8-flash-next` is not in the catalog. Its only Ollama tags are Apple MLX and NVIDIA NVFP4, with no
  GGUF build. Flash-Next therefore cannot be run through the Hub's Ollama path on Strix Halo, and
  `qwen3.8:27b` (with its `-mtp-q4_K_M` variant) is the only like-for-like model between Ollama and Gufo.

## What a fair test needs

1. **One idle Strix Halo node**, with no Hub apps resident, and the same node for every arm.
2. **Same model, same weights family.** Ollama `qwen3.8:27b` and `qwen3.8:27b-mtp-q4_K_M` against Gufo
   Qwen3.8 27B Q4_K_XL, autoregressive and with DFlash2. Run Halogen and Gufo on Flash-Next against each
   other only.
3. **Paired per-prompt ratios** across prose, code, and JSON prompts. The fleet's own lesson is that pooled
   ranges across different prompts hide the effect and that a scalar uplift is meaningless.
4. **Record the backend of each arm.** Ollama on this hardware runs Vulkan. Both candidates need ROCm, so a
   ROCm Ollama arm is a useful third control.
5. **Measure the co-tenant cost.** Repeat each arm with the Hub's normal apps loaded, because that is the
   configuration the appliance ships in, and it is where Halogen and Gufo document or report trouble.
6. **Check lossless claims** with token-level comparison at temperature 0, not output-hash equality, which
   the fleet found unreliable on some builds.

## Sources

- [peonist-ai/halogen-flash-server](https://github.com/peonist-ai/halogen-flash-server): README, `LICENSE.md`, issues.
- [gufo-org/gufo](https://github.com/gufo-org/gufo): README, `docs/SERVER.md`, `docs/CLI.md`, issues, releases.
- [lemonade-sdk/lemonade](https://github.com/lemonade-sdk/lemonade), [jundot/omlx](https://github.com/jundot/omlx): READMEs.
- Hub code: `packages/backend/src/modules/inference/backends/`, `eval/driver-conformance.ts`
  (`SPEC_DECODE`), `catalog/curated-models.ts`, `packages/common/src/types/inference.ts`.
- Hub docs: [`inference-supervision.md`](inference-supervision.md), [`fleet-benchmark-results.md`](fleet-benchmark-results.md),
  [`agent/sessions/2026-09-28-llm-backend-audit-and-cleanup.md`](agent/sessions/2026-09-28-llm-backend-audit-and-cleanup.md).

## Limits of this research

- Star counts, issue counts, and release dates are from the GitHub API on 2026-10-04 and change daily.
- Fleet figures labeled (fleet) come from earlier sessions' notes and were not re-measured.
- Nothing was run on a Strix Halo node. The `owned_by` behavior of both candidates, Gufo issue #414 on
  v0.7.0, and Gufo's behavior beside other resident models were not tested.
