# Model Registry & Hardware Benchmarking

The Model Registry in CI-Hub is the catalog of curated open-weight models CI-Hub can pull and run
locally via Ollama (plus a few Lemonade-backed voice models), mapped to hardware profiles so the
onboarding flow (FTUE) and Settings can recommend a model that actually fits the user's machine.

## 1. Where the catalog lives

`packages/backend/src/modules/inference/catalog/curated-models.ts` is the single source of truth.
It's authored as a compact, pipe-delimited [TOON](https://toonformat.dev) table (`CATALOG_TOON` for
LLMs, `EXTRAS_TOON` for voice/embedding models) — one row per model — and decoded at module load into
`CuratedModel[]` (`CURATED_MODELS`). Every family + size in the table is verified to exist on
[ollama.com/library](https://ollama.com/library); the catalog lists only the bare `model:size` default
tag (the guaranteed-pullable `q4_K_M` build). `intel`/`tps`/`ttft`/`e2e` columns come from the
[Artificial Analysis open-weights leaderboard](https://artificialanalysis.ai/leaderboards/models?weights=open)
where the model is listed; they're left blank otherwise.

> **Scale warning (2026-09-16).** The Ollama table's `intel`/`tps`/`ttft`/`e2e` columns were re-pulled in
> one pass from Artificial Analysis **Intelligence Index v4.3**. AA rebases its index between versions
> (v4.3 roughly halved most scores), and `compareLlmCandidates()` ranks across rows on this column, so
> never patch a single row from a newer leaderboard — re-pull the whole column or leave it. The old
> `agentic` (tool-use) column was dropped on the same date: v4.3 publishes no composite agentic index,
> and the values were a never-refreshed May 2026 snapshot that nothing ranked on. The `(MTP)` rows carry their base row's leaderboard columns on
> purpose (identical weights, lossless speculative decoding); see the dated note in
> `curated-models.ts`.
>
> **AA moved to Intelligence Index v5.0.1 (checked 2026-11-15).** The open-weights page's embedded data
> now scores only 44 open-weights models, and only 7 of the 109 Ollama rows then in the table have an entry, so
> a whole-column re-pull would blank about 70 rows' scores and reorder the recommendations. The table
> therefore keeps its v4.3 column, and rows added since carry no `intel`/`tps`/`ttft`/`e2e` at all: a v5.0.1
> number beside v4.3 ones would rank against them as if they shared a scale. The page also no longer carries
> an end-to-end time per model. When AA scores most of the catalog's models again, re-pull the columns for
> every row in one pass.

`curated-models.ts` derives everything else (VRAM/RAM requirements, disk size, memory footprint,
per-tier recommendation flags) from the row's `params`/`gb`/`tier` columns — there is no separate
hand-maintained sizing formula to keep in sync. The one exception is the optional `ramGb` column: a
memory footprint measured on a running engine, for a row whose download does not predict it (see
[Measured footprints](#measured-footprints)).

## 2. How recommendations are computed

`model-registry.service.ts` computes hardware-fit recommendations directly from `CURATED_MODELS` —
there is no separate hand-maintained ID→hardware-bracket table to keep in sync with the catalog.

1. `computeInferenceBudget()` turns a `HardwareProfile` into a usable memory budget (discrete VRAM,
   Apple/AMD unified memory, or CPU/system RAM), applying the appropriate headroom fraction
   (`VRAM_BUDGET_FRACTION` / `UNIFIED_MEMORY_BUDGET_FRACTION` / `SYSTEM_RAM_BUDGET_FRACTION`).
2. `pickBestFittingLlms()` filters the catalog to models whose `runtime.memoryFootprintMb` fits that
   budget (and, on bandwidth-constrained x86 APUs, whose *active* parameter count is small enough),
   then ranks candidates with `compareLlmCandidates()` — highest Artificial Analysis Intelligence Index
   first, then largest parameter count, then best quantization — and returns a size-spanning
   small/medium/large short list (`MAX_RECOMMENDED_LLMS`, currently 5). Index 0 is what app bootstrap
   auto-installs.
3. The per-row `tiers` object (`high`/`medium`/`low`/`cpuOnly`, each `recommended`/`available`/
   `not-recommended`) still gates which models are browsable at all for a given hardware tier
   (`getModelsForTier`) and drives the *non-LLM* recommended defaults (voice/embedding), but for LLMs
   the actual best-fit ranking above is what selects the recommended set — not this field alone.
4. A download (`ModelPullerService.evaluatePull`) ignores what is loaded right now. It refuses a model
   only when its weights cannot fit in the node's whole model budget with nothing else loaded: a
   discrete card's VRAM less 512 MB, otherwise the RAM budget. The weights are measured by a lower
   bound, 4 bits per parameter (`params`) capped at the download size, not by `memoryFootprintMb`.
   For most rows that footprint is the download plus 10 %, and some downloads hold far more than the
   engine puts on the card. A model that only its footprint says will not fit still downloads, and
   the Hub logs a warning that a pin or load may refuse it. So a 10 GB card downloads gemma4-e4b and
   refuses gemma4-31b (at least 14,781 MB).

The frontend (onboarding `RecommendedModels`/`OtherModels` in
`packages/frontend/src/modules/onboarding/components/ai-setup/model-selection-card.tsx`, and the
equivalent Settings AI page) reads the same `CuratedModel[]` the backend serves — there's no separate
model list to update on the frontend side.

### Measured footprints

A row with a `ramGb` value carries a footprint measured on the fleet instead of one derived from `gb`.
The figure is what the engine process held once loaded, less the KV cache and compute buffers its load
log reports. Read the process with nvidia-smi or rocm-smi on a discrete card, or with the process's DRM
fdinfo on a unified-memory APU. The Hub charges the KV cache separately, per token of the window it
loads, and the compute buffers fall inside the fixed safety margin it adds, so what is left is the
weights, the encoders, and the runtime, which do not change with the window. Such a row is marked
`footprintMeasured`, and context sizing then uses the measurement as the base instead of raising it to
the file size.

Use this column only for a figure you measured. Do not read the figure from `/api/ps`: Ollama 0.34
builds that value from llama-server's log lines, and for gemma4 it drops a KV cache and the image
and audio encoder weights. On beta-red it reported 3,209 MiB for gemma4:e4b while nvidia-smi showed
5,550 MiB for the process.

Do not derive the figure from another row's measurement either. The footprint decides recommendations
as well as loads: index 0, the model app bootstrap auto-installs, is the best model whose footprint
fits the budget. gemma4-e2b's load logs suggest about 2,925 MiB, e4b's reading less the difference in
their weights, but no node has held it to read. With that figure it became index 0 on every 4 GB card,
a 7.2 GB download in place of nemotron-3-nano-4b's 2.8 GB, and the load estimate then refused it on
that card. It stays derived from `gb` until a node measures it, and `model-registry.service.test.ts`
pins the default on the smallest profiles.

The gemma4 E4B download is the reason for the column. Most of gemma4:e4b's 9,163 MiB file is a
per-layer embedding table (5,376 MiB) that llama.cpp leaves memory-mapped on the host. Its weights,
encoders, and runtime come to 4,046 MiB on an RTX 3080 and 4,357 MiB on Strix Halo, and the row
carries the larger. Derived from the download, the footprint was 10,813 MB, which refused the fleet's
default app model on 8 and 10 GB cards. The dated note above `CATALOG_TOON` records every measurement
and the node it came from.

The figure leaves out llama-server's prompt cache. llama-server keeps recent prompts' KV state in host
RAM, up to 8 GiB by default (`--cache-ram 8192`; Ollama 0.34 does not pass the flag), and that memory
shows in the process's anonymous RSS, not in what the GPU holds. On core-2 (Strix Halo), the
gemma4:e4b process held 8,490 MiB of `RssAnon` beside 9,098 MiB of VRAM and GTT by DRM fdinfo. The
same model on beta-max, whose cache had not filled yet, held 216 MiB. On a discrete card that is system
RAM, outside what the card gives models. On unified memory it comes out of the same pool the models
draw on, so the process can take up to about 8 GiB more than the Hub charges. The unified-memory fit
check reads live `MemAvailable`, which sees the cache once it has grown, and the gap is the same for
every model, measured or derived. The 10,813 MB derived figure happened to cover most of it for
gemma4:e4b. Charging the cache is left to a separate change.

## 3. How to add a new model

If a new frontier open-weight model is released:

### Step A: Verify it's on Ollama

Confirm the exact pull tag(s) at `ollama.com/library/<name>` (or `ollama.com/blog` for a launch
announcement). **Only add rows for tags you've verified actually exist** — `curated-models.test.ts`
has a regression test (`contains no fabricated families/sizes`) that blocklists known-fake IDs, and
this list grows every time a fabricated entry almost slips in. Each name on that list records a judgment
made on the day it was added. Mistral Medium 3.5 was banned in 2026-07 and 2026-08 and is real: the
registry manifest, the GGUF header, and the Hugging Face repo, all older than the bans, show it (checked
2026-11-15). Before you give up on a banned name, re-check it against raw registry data, and when it holds
up, take it off the list with the evidence in the test.

Read the facts from primary data, never a summary: the manifest at
`https://registry.ollama.ai/v2/library/<name>/manifests/<tag>` (send `Accept:
application/vnd.docker.distribution.manifest.v2+json`; its layers' sizes add up to `gb`, and the config
blob it points to carries `file_type`, which should be `Q4_K_M`, and, when set, the minimum Ollama version it
`requires`), and a ranged read of the GGUF header for the architecture and `context_length`. A tag that
exists only as a `:cloud` proxy, or whose only builds are MLX or NVFP4 safetensors, is not a row. The table
labels every row `q4_K_M`, and a few older rows are exceptions (the `gpt-oss` rows are MXFP4 and `gemma3:270m`
is Q8_0), so name any other build with a different `file_type` in the dated note. An Ollama older than a
build's `requires` gets HTTP 412 from the registry, so compare it with the fleet's pin
(`scripts/lib/fleet-ollama-version.ts`) and name in the dated note any row the pin cannot pull.

For a model Ollama's library does not carry, look in the vendor's own Ollama namespace (`ollama.com/<vendor>`,
as with `openbmb/minicpm-v4.7`, `openbmb/minicpm5`, and `ifm/k2-horizon`) before an `hf.co/` row, and read its
manifests as you would a library row's. A vendor build's config blob can declare `capabilities` and a `requires`
version that an `hf.co/` tag lacks. The config blob of `ifm/k2-horizon:0.9b-q4_K_M` declares thinking and tools.
On Ollama 0.40.16, on 2026-11-15, `hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M`, the same model layer, reported
tools and completion only, and `think: true` answered HTTP 400. Read the GGUF's chat template too, because
repos of one model can carry different ones: bartowski's K2 Horizon GGUFs for 3.7B, 7B, 32B, MoVA, and 375B
carry a template that raises on an assistant turn with no thinking field, and IFM's five do not (checked
2026-11-15).

Otherwise an `hf.co/<repo>:<quant>` row works only if Ollama can pull it, and it cannot pull a sharded GGUF.
Ask Hugging Face's registry endpoint the way Ollama does, before anything else:

```bash
curl -s -w '\n%{http_code}\n' -A 'ollama/0.34.0 (arm64 darwin) Go/go1.24.0' \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  https://huggingface.co/v2/<repo>/manifests/<QUANT>
```

`200` is a single-file quant that pulls. `400` with "only contains sharded GGUF files" is a model that
cannot be installed this way, however real it is (checked 2026-11-15: GLM 5.2 and Inkling, which are in the
table, return it too). Quants much past 50 GB are usually split (Mistral Small 4's 73 GB Q4 build is two or
three shards, depending on the publisher), so expect most large models to fail here. A re-host on Ollama's
own registry with one merged blob is the usual way around it, as `frob/mistral-small-4:119b` does. Before you
list a re-host, read its GGUF header's `general.quantized_by` and `general.base_model.*.repo_url` and confirm
they name the vendor's repo or a known quantizer. Take the license from the vendor's card, because a
re-host can drop the license layer, and compare its system prompt and template with the vendor's.

### Step B: Append a TOON row

Open `curated-models.ts` and add one line to `CATALOG_TOON` (or `EXTRAS_TOON` for voice/embedding
models), following the column header comment at the top of the file:

```
newmodel-72b|newmodel:72b|NewModel 72B|reasoning|72|43|high|128|SomeLab||1|0|1|0||||
```

- `id` — `${family}-${size}`, kebab-case, unique.
- `backendModelId` — the exact `ollama pull` tag.
- `params`/`gb` — parameter count (billions, the library's size label) and the *default* (`q4_K_M`)
  download in decimal GB to one decimal: the sum of every layer in the manifest (Step A), which the library
  page rounds further. These two columns drive every derived requirement
  (`minVramMb`/`recommendedVramMb`/`minRamMb`/`diskMb`/`memoryFootprintMb`) — don't hand-compute them.
  For a model named by its *effective* size, use that figure: the Gemma E4B row carries 4, not the
  8.0B Ollama reports, because the download gate reads `params` as a lower bound on what the engine
  holds (§2, item 4).
- `tier` — the lowest hardware tier this size should be offered as a default recommendation for
  (`cpu-only`/`low`/`medium`/`high`), based on the model's footprint relative to existing rows of
  similar size.
- `reason`/`vision`/`tools` — what the build offers through Ollama, not the library page's badges, which
  join every build of a family (`olmo-3.1` shows tools, but its Think build has none) and ignore a GGUF chat
  template that Ollama prefers (MiniCPM5). Ollama (`Model.Capabilities` in `server/images.go`, read at v0.34.0
  with `OLLAMA_GO_TEMPLATE` unset) adds up the config blob's `capabilities`, the tool and thinking support of
  its `parser`, vision from a projector layer or from `<arch>.vision.block_count` in the model file, and the
  tools and thinking of one template. The Go template layer offers `.Tools` and, inside the messages loop
  between literal opening and closing tags, `.Thinking`. The GGUF's chat template offers a `tools` or
  `tool_call` substring, and a literal `<think>` and `</think>` (or a split of `content` at `</think>`, in a
  template with neither `reasoning_content` nor `<SPECIAL_12>`). A build with a Go template layer uses it,
  unless the build has no `parser` or `renderer` and the GGUF's chat template offers more capabilities
  (counted, so `.Suffix` counts too) while keeping any tool round trip the Go template has, or offers the same
  and alone completes one (`shouldPreferChatTemplate`). A build with no Go template layer uses the GGUF's chat
  template, but a build with a `parser` or `renderer` never has it read: `olmo-3.1`, with a parser and no
  template layer, has only what its parser offers, and a parser build that has a Go template layer gets that
  template's capabilities as well (`devstral-2`). Hy3's builds its think tokens from a format string, so it has
  no thinking flag. Check with `/api/show` on a current Ollama when you can. The pool routes a request that
  asks for tools or thinking by these flags (`pool-auto-model.ts`) and passes over a build whose flag is 0,
  while Ollama refuses `think` for a build without the capability (HTTP 400). A flag that claims more than the
  build offers sends requests to a refusal, and one that claims less hides the build.
- `intel`/`tps`/`ttft`/`e2e` — leave blank (`|`). The columns are on AA's v4.3 index and AA now publishes
  v5.0.1 (see the note at the top), so a new number would rank on a different scale. Don't invent numbers.
- `ramGb` — leave it blank. Fill it in only with a footprint you measured on a running engine, as
  [Measured footprints](#measured-footprints) describes, and record the measurement in a dated note.
- If the model is a Mixture-of-Experts (MoE) model, also add its active-parameter count (billions) to
  the `MOE_ACTIVE_PARAMS_B` map just below the LLM table — this governs shared-memory/APU selection,
  which is bandwidth- (active-param-) bound rather than capacity-bound.

Also bump the row count in the table's header: `llms[N|]` is the number of rows the decoder reads. A count
that is too high makes it throw, but one that is too low drops the last rows without a word, so the row
counts in the `decodes the full catalog` test (Step D) are what catch a forgotten bump.

### Step C: Generate the new rows' geometry entries

A new Ollama row has no entry in `kv-geometry.generated.ts` until you generate one, and until then its
download size and memory footprint come from the TOON's rounded `gb`. Add the entries with the tool, from
the repo root:

```bash
pnpm exec tsx scripts/catalog/gen-kv-geometry.ts --only newmodel-72b
```

`--only` (comma-separated ids) reads only those rows' GGUF headers from the registry and merges them into
the file, leaving every other entry byte for byte as it was. It needs network but, for Ollama rows, no
Lemonade install. For an `hf.co/` row it sizes every layer of Hugging Face's Ollama manifest, so a vision
projector counts as it does for a registry row. It reads the header of the file whose name ends with the
quant (`Hy3-Q4_K_M.gguf`, not its `Hy3-Q4_K_M-mtp.gguf` sibling, which has one more block). A row with no
such file, or whose file's size is not the model layer the manifest serves, is left unresolved. So is a row
that Hugging Face's endpoint refuses for any reason but a sharded repo: a quant the repo does not list
answers HTTP 400 too. A sharded repo (HTTP 400 "sharded GGUF") is sized from its files in the tree, and
`check-rows.ts` is what reports that Ollama cannot pull it. The tool
lists at the end any row it could not resolve: check that row's tag or file again before you commit it. If
a line in the table is not shaped like a generated entry (a comment or a hand-written line), the tool stops
and writes nothing, because merging would drop that line; run it without `--only` to rebuild the whole
file. A hand-edited value inside an entry is kept as it is. The date in the file's header is the last
run's, so it does not say when each entry was read.

### Step D: Update the catalog tests

Open `packages/backend/src/modules/inference/__tests__/curated-models.test.ts`:

- Bump the per-backend counts and `llms.length` (and `embedding`/`tts`+`stt` counts if you touched
  `EXTRAS_TOON`) in the `decodes the full catalog` test; the oMLX count is asserted a second time in the
  `gates oMLX rows to Apple Silicon only` test.
- Optionally add a spot-check assertion for the new model (mirrors the existing `gemma4-31b` /
  `llama3-3-70b` checks) to lock in its derived requirements and metadata.

```bash
cd packages/backend && pnpm exec vitest run src/modules/inference/__tests__/curated-models.test.ts
```

### Step E: Check that no default moved

The recommender ranks on the AA index first and counts an unscored row as 0, so among the oMLX and vLLM
rows (none is scored) the largest parameter count that fits wins, and index 0 is what app bootstrap
installs. A new row can take that place on some memory size, and none of its own tests will say so. Compare
the picks with and without the new rows across memory sizes:

```bash
cd packages/backend && pnpm exec tsx ../../scripts/catalog/recommendation-sweep.ts newmodel-72b,newmodel-72b-mlx
```

Every `DEFAULT CHANGED` line is a decision. On 2026-11-15 the sweep caught `laguna-xs-2-1-mlx` replacing
DeepSeek R1 32B as the default on a 32 GB Mac, and that row was left out. Lines at sizes nobody ships (a
40 GB Mac, a 70 GB card) are hints about ranking rather than changes to a real configuration. The new row
appearing in a top-5 list is expected; only index 0 is flagged.

### Step F: Check every row against its registry

Run the checker on the rows you added, and on the whole catalog before you open the pull request:

```bash
pnpm exec tsx scripts/catalog/check-rows.ts --only newmodel-72b,newmodel-72b-mlx
pnpm exec tsx scripts/catalog/check-rows.ts
```

For every LLM row it reads the same primary data as Step A, in about a minute, and prints one line per row. It only
sends `GET` requests for small JSON: no pull, and no weights. Each backend gets its own checks:

- **Ollama rows** (the library, `openbmb/`, `frob/`, and any other namespace): the manifest answers 200; its layers
  add up to the row's `fileBytes` in `kv-geometry.generated.ts` and, within 10%, to its `gb`; the config blob's
  `file_type` is the row's quant label (the table's three known exceptions are in `FILE_TYPE_EXCEPTIONS` in
  `scripts/catalog/row-checks.ts`); its `requires` is not above `OLLAMA_PINNED_VERSION`; and it is not a cloud
  proxy (`remote_host`, or a `cloud` tag).
- **`hf.co/` rows**: Hugging Face answers the Ollama manifest request the way Step A shows, and a sharded repo (HTTP
  400) is a failure. The layers, a vision projector among them, add up to `fileBytes` and, within 10%, to `gb`. The
  pull tag is the row's quant label, because Hugging Face's config blob states no `file_type`; a row that pulls
  another quant on purpose (such as `UD-Q4_K_XL`) goes in `FILE_TYPE_EXCEPTIONS` under the tag it pulls.
- **oMLX and vLLM rows**: the repo exists and is not gated, its `.safetensors` at the repo root add up to `gb` (decimal
  GB; a subfolder such as `original/` is not loaded and is not counted), and `config.json`'s
  `max_position_embeddings` reaches the window the row advertises. A repo with no weight file at its root at all
  fails; one whose weights are in another format (`.bin`, `.gguf`) warns, because the script cannot size them.
- **Lemonade rows** are listed and skipped. They name a key in the server's own registry, which the script does not read.

`FAIL` means the row cannot work as listed: its model cannot be pulled, its repo is missing, gated or empty, or it is a
cloud proxy. `UNREAD` means the script could not read or make sense of the data, so nothing is known about the row: a
registry did not answer (a network error, or HTTP 429 or 5xx after three tries; a `Retry-After` over 30 seconds is not
waited for), or an answer lacked what a check needs (a layer with no size, a record with no `gated` field, a body that
is not JSON). Run the check again; if the row stays `UNREAD`, the message says what was missing. Both make the command
exit 1. `WARN` is drift: a size, a quant label, a window,
or an Ollama version above the pin, which an older Ollama answers with HTTP 412. A warning exits 0 unless you pass
`--strict`. Treat every finding as a decision, and write it down in the dated note: correct the row, change the pin,
or, for a build that is not `q4_K_M` on purpose, add it to `FILE_TYPE_EXCEPTIONS` with the reason.

`--format md` prints the table as GitHub Markdown for a pull request description, and `--format json` prints it for a
script. `--concurrency <n>` changes how many reads run side by side (the default is 4; Hugging Face allows 500 API
requests per 5 minutes without a token, and a whole-catalog run uses fewer than 200).

No changes are needed in `model-registry.service.ts`, the frontend model-selection components, or
`icons.tsx` for a model whose creator already has a brand mark in `packages/frontend/public/brands/`
(check the `CREATOR_BRAND` map) — the new row is picked up automatically everywhere. A creator without
a brand SVG just falls back to a generic icon; that's expected and fine.

## 4. Lemonade rows

`LEMONADE_LLM_TOON` names models by their key in Lemonade's own registry (`server_models.json`). The
rows were checked against lemonade-server 2026.39.1, but a host runs whatever Lemonade it has: every
fleet Lemonade node runs the Ubuntu apt package 10.2.0, which lacks 13 of the 41 rows.

- **The catalog follows the connected server.** On each health probe (at most once a minute) the Hub
  reads `GET /v1/models?show_all=true`. A Lemonade row that listing does not name is dropped from
  `getModelsForTier()`, so it is not browsable, recommended, or pre-pulled, and `evaluatePull` refuses
  it with a reason that names the registry. A model the Hub registers itself (`LEMONADE_REGISTRATIONS`)
  counts as offered. A Lemonade that ignores `show_all`, or one the Hub has not reached, filters nothing.
- **Registered models may carry a namespace.** `/v1/pull` registers a Hugging Face checkpoint under
  `user.<id>`. Lemonade 10.2.0 lists and serves it only under that name; 2026.39.1 lists it as `<id>`.
  The Hub treats `user.<id>` as serving catalog `<id>`, and hands out and loads whichever spelling the
  server lists. `user.<id>` resolves on every version, so it is the name used before the server lists it.
- **Names are case-sensitive.** The Whisper rows use Lemonade's keys (`Whisper-Base`,
  `Whisper-Large-v3-Turbo`); the lowercase ids they carried until 2026-09-29 were never servable.

### Lemonade embedder: v1 and v1.5

Until #1679 (2026-09-29) a Lemonade-only host embedded with Lemonade's built-in
`nomic-embed-text-v1-GGUF`. The recommended Lemonade embedder is now nomic v1.5
(`nomic-embed-text-v1.5-GGUF`, registered by the Hub on pull), the same weights as Ollama's
`nomic-embed-text`, so switching engines no longer strands an index.

v1 and v1.5 are different vector spaces (cosine about 0.7 on the same text) at the same 768
dimensions, so pgvector accepts a mix of them without complaint and search quietly gets worse. To
avoid that:

- A Lemonade-only host that has v1 downloaded and not v1.5 keeps being handed v1
  (`nomic-embed-text-v1-lemonade`, still in the catalog but never recommended).
- A host moves to v1.5 when the operator picks it as the preferred embedding model in
  Settings → AI, or once v1.5 is on the host. **Re-embed the stored memories after that switch**: vectors
  written with v1 do not match queries embedded with v1.5.
- A host running Ollama as its chat engine embeds with Ollama's `nomic-embed-text` as before.

### The embedder runs on the CPU on AMD ROCm hosts

Two llama-server processes on one AMD card make the GPU spin at 100 % and max clock while idle
(ROCm/ROCm#5107 — MES hardware-queue oversubscription; AMD has a firmware fix for gfx12 only, gfx11
including Strix Halo is pending). Lemonade spawns llama-servers with its own environment, so the
`GPU_MAX_HW_QUEUES=1` workaround cannot reach them. So on an AMD host with ROCm the Hub loads an
embedder with `llamacpp_backend: cpu` (saved beside the batch flags), leaving the chat model as the
card's only process; `embedderRunsOnCpu` in `embedder-placement.ts` is the rule, with the
measurements. nomic v1.5 on a Ryzen 9 7900X embeds a 32-text batch in 1.6 s and a query in 21 ms.

### `embedding_base_url` replaces `ollama_embed_host`

An app's manifest may now map `embedding_base_url` (an OpenAI-style base, `…/v1`, the sibling of
`llm_base_url` — whichever engine embeds for the app, or the pool proxy) instead of
`ollama_embed_host` (the same server as a root, named when only Ollama embedded). Both are emitted;
Companion Memory reads the new one as `LLM_EMBEDDING_API_BASE`. Move a manifest to the new key only
once every Hub that installs it carries this version: an older Hub's manifest schema rejects an
unknown inference key and reports the app not found.

### The chat engine embeds for itself

Since 2026-09-30 an app embeds on the same engine it chats on whenever the catalog gives that
engine an embedder (Ollama, Lemonade). Only an engine with no embedder (vLLM, oMLX) borrows a
healthy Ollama, and has no embedder without one. Until then a healthy Ollama embedded next to
Lemonade, to keep Memory's index on Ollama's `nomic-embed-text` — but the Lemonade embedder is
the same v1.5 weights, CI-Server declares both names one embedding generation (and re-embeds by
stage version if an embedder really changes), and the split put two engines that cannot see each
other's memory on one card: a Lemonade 27B pinned at boot left Ollama 1.6 GiB, so its embedder ran
on the CPU. `embeddingBackendFor` in `embedder-handout.ts` is the rule; both handout paths use it,
and the Hub's own `/v1/embeddings` routes each request to the engine that lists its model.
