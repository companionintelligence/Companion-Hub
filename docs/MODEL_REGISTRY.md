# Model Registry & Hardware Benchmarking

The Model Registry in CI-Hub is a dynamic, scalable catalog of state-of-the-art frontier models and edge-optimized tools. It maps highly diverse LLMs—spanning from lightweight 4B parameters up to massive 3T data center arrays—to precise hardware profiles automatically.

## 1. Overview of Expansion & Supported Models

The `curated-models.ts` catalog has been vastly expanded. It dynamically calculates memory footprints, quantization mults, and hardware tiering for **~15 major model families** representing the bleeding-edge of open-weight intelligence:

- **Gemma Family**: 4B to 3T parameters (`gemma4-3t`)
- **Qwen Family**: 8B to 1.5T parameters (`qwen3-6-1-5t`, `qwen3.5-397b-a17b` MoE)
- **DeepSeek Reasoning**: `v4-pro` (500B), `v4-flash` (100B), `r10528` (200B)
- **Mistral**: `mistral-medium-3.5`, `mistral-small-3.2`
- **Nemotron / Hermes 4**: Extensive parameter scales spanning 4B up to 1T for broad assistant and logic capabilities.
- **GLM / MiMo / Kimi / MiniMax / QwQ**: Targeted reasoning and specialist variants optimized for 32GB–128GB tiers.

These families automatically generate into over **120 unique model + quantization combinations**, spanning quantizations from `fp16` to `q3_K_M`.

## 2. Hardware Benchmarking & Scaling Math

Instead of hard-coding every model variation, the CI-Hub registry utilizes an algorithmic benchmarking system that scales minimum hardware prerequisites depending on the **total parameter count (`p`)** and the **quantization footprint (`mult`)**.

### Benchmarking Formulas
When the catalog is initialized, it dynamically generates resource limits. Below is the simplified approximation used internally to evaluate if a user's machine can support a given model variation:

1. **VRAM Benchmark**:
   - Base Footprint: `p * 600` (e.g. 70B = ~42,000 MB Base VRAM)
   - Final `minVramMb`: `Math.round(Base * quant_mult)`
   - _Note_: 4-bit (`q4_K_M`) quantization has a multiplier of exactly `1.0`. `fp16` scales up by `3.2x`.

2. **RAM Overhead Benchmark**:
   - The registry enforces a very strict RAM boundary to ensure system stability when spilling. 
   - Formula: `Math.round((p * 1800) * quant_mult)`
   - A `gemma4-3t` (3000B) thus demands an immense ~5.4TB RAM overhead to handle contextual context processing safely.

3. **Recommendation Breakdown**:
   - The `LLM_RECOMMENDATION_TABLE` in `model-registry.service.ts` cross-references the user's `effectiveInferenceMemoryMb` (VRAM) and guarantees that the system RAM clears the respective constraints before matching them to brackets (ranging from **2GB** to **2048GB VRAM**).

## 3. How to Add and Edit Models in the Installer

If a new frontier model is released, integrating it into the CI-Hub onboarding recommendation engine takes only a few minutes.

### Step A: Define the Family Configuration
Open `/packages/backend/src/modules/inference/catalog/curated-models.ts` and append the model structure to the `FAMILIES` array. Ensure the parameter count `p` accurately reflects the model footprint.

```typescript
{
  prefix: 'newmodel',
  idPrefix: 'newmodel',
  name: 'NewModel 1',
  purpose: 'reasoning',
  sizes: [
    { s: '14b', idSize: '14b', p: 14, tier: 'low' },
    { s: '72b', idSize: '72b', p: 72, tier: 'high' }
  ]
}
```
*Note for MoE Models:* Use the total uncompressed parameter size for `p` (not just active parameters) to assure sufficient baseline memory allocation, as our scaling calculates upper bounds.

### Step B: Slot into the Recommendation Table
Open `/packages/backend/src/modules/inference/model-registry.service.ts` and locate the `LLM_RECOMMENDATION_TABLE`. Find the appropriate memory bracket and inject the model's generated `id`:

```typescript
// Example: Slotting 72B into the 96GB VRAM bracket
{ minVramMb: 98304, minRamMb: 131072, recommendedModelIds: ['newmodel-72b'] }
```
_IDs are generated via: `idPrefix-idSize-quant` (e.g., `newmodel-72b-q8_0`). Unquantized / `q4_K_M` drop the suffix (`newmodel-72b`)._

### Step C: Test the Hardware Configuration
Open `/packages/backend/src/modules/inference/__tests__/model-registry.service.test.ts`. Find the `describe('Hardware Recommendation Tiers')` block and add the new model into the test assertions for its respective bracket to enforce that the math perfectly clears.

```bash
pnpm dlx vitest run src/modules/inference/__tests__/model-registry.service.test.ts
```
