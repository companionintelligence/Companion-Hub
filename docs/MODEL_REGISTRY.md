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
tag (the guaranteed-pullable `q4_K_M` build). `intel`/`agentic`/`tps`/`ttft`/`e2e` columns come from the
[Artificial Analysis open-weights leaderboard](https://artificialanalysis.ai/leaderboards/models?weights=open)
where the model is listed; they're left blank otherwise.

`curated-models.ts` derives everything else (VRAM/RAM requirements, disk size, memory footprint,
per-tier recommendation flags) from the row's `params`/`gb`/`tier` columns — there is no separate
hand-maintained sizing formula to keep in sync.

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

The frontend (onboarding `RecommendedModels`/`OtherModels` in
`packages/frontend/src/modules/onboarding/components/ai-setup/model-selection-card.tsx`, and the
equivalent Settings AI page) reads the same `CuratedModel[]` the backend serves — there's no separate
model list to update on the frontend side.

## 3. How to add a new model

If a new frontier open-weight model is released:

### Step A: Verify it's on Ollama

Confirm the exact pull tag(s) at `ollama.com/library/<name>` (or `ollama.com/blog` for a launch
announcement). **Only add rows for tags you've verified actually exist** — `curated-models.test.ts`
has a regression test (`contains no fabricated families/sizes`) that blocklists known-fake IDs, and
this list grows every time a fabricated entry almost slips in.

### Step B: Append a TOON row

Open `curated-models.ts` and add one line to `CATALOG_TOON` (or `EXTRAS_TOON` for voice/embedding
models), following the column header comment at the top of the file:

```
newmodel-72b|newmodel:72b|NewModel 72B|reasoning|72|43|high|128|SomeLab|38.2|41.0|1|0|1|0|90|1.2|8.5
```

- `id` — `${family}-${size}`, kebab-case, unique.
- `backendModelId` — the exact `ollama pull` tag.
- `params`/`gb` — parameter count (billions) and the *default* (`q4_K_M`) on-disk size in GB, exactly
  as shown on the Ollama library page. These two columns drive every derived requirement
  (`minVramMb`/`recommendedVramMb`/`minRamMb`/`diskMb`/`memoryFootprintMb`) — don't hand-compute them.
- `tier` — the lowest hardware tier this size should be offered as a default recommendation for
  (`cpu-only`/`low`/`medium`/`high`), based on the model's footprint relative to existing rows of
  similar size.
- `intel`/`agentic`/`tps`/`ttft`/`e2e` — from the Artificial Analysis leaderboard if the model is
  listed there; leave blank (`|`) otherwise. Don't invent numbers.
- If the model is a Mixture-of-Experts (MoE) model, also add its active-parameter count (billions) to
  the `MOE_ACTIVE_PARAMS_B` map just below the LLM table — this governs shared-memory/APU selection,
  which is bandwidth- (active-param-) bound rather than capacity-bound.

### Step C: Update the catalog tests

Open `packages/backend/src/modules/inference/__tests__/curated-models.test.ts`:

- Bump the `llms.length` (and `embedding`/`tts`+`stt` counts if you touched `EXTRAS_TOON`) in the
  `decodes the full catalog` test.
- Optionally add a spot-check assertion for the new model (mirrors the existing `gemma4-31b` /
  `llama3-3-70b` checks) to lock in its derived requirements and metadata.

```bash
pnpm --filter @ci-hub/backend exec vitest run src/modules/inference/__tests__/curated-models.test.ts
```

No changes are needed in `model-registry.service.ts`, the frontend model-selection components, or
`icons.tsx` for a model whose creator already has a brand mark in `packages/frontend/public/brands/`
(check the `CREATOR_BRAND` map) — the new row is picked up automatically everywhere. A creator without
a brand SVG just falls back to a generic icon; that's expected and fine.
