import { describe, expect, it } from 'vitest';
import { omlxModelKey } from '@/common/helpers/omlx-model-id';
import { LEMONADE_REGISTRATIONS } from '../backends/lemonade.backend';
import { CURATED_MODELS } from '../catalog/curated-models';
import { GGUF_KV_GEOMETRY } from '../catalog/kv-geometry.generated';

/**
 * The LLM catalog is authored as a pipe-delimited TOON table and decoded at module load. These tests
 * exercise the decoder + derivation: counts, derived requirements, real context windows, and the
 * Artificial Analysis metadata (creator / intelligence index / capabilities / perf).
 */
/** A row's files in MiB, from the header table: the download size the catalog now carries. */
const fileMb = (id: string) => {
  const bytes = GGUF_KV_GEOMETRY[id]?.fileBytes;
  return bytes ? Math.round(bytes / 1024 ** 2) : undefined;
};

describe('curated-models (TOON catalog)', () => {
  const byId = new Map(CURATED_MODELS.map((m) => [m.id, m]));
  const llms = CURATED_MODELS.filter((m) => m.modality === 'llm');

  it('decodes the full catalog (125 Ollama LLMs + 41 Lemonade LLMs + 13 vLLM LLMs + 76 oMLX LLMs + voice + embeddings) with unique ids', () => {
    expect(llms.filter((m) => m.backend === 'ollama').length).toBe(125);
    expect(llms.filter((m) => m.backend === 'lemonade').length).toBe(41);
    expect(llms.filter((m) => m.backend === 'vllm').length).toBe(13);
    expect(llms.filter((m) => m.backend === 'omlx').length).toBe(76);
    expect(llms.length).toBe(255);
    // 4 Ollama embeddings + 2 Lemonade embeddings (v1.5, recommended; v1, kept for existing indexes).
    expect(CURATED_MODELS.filter((m) => m.modality === 'embedding').length).toBe(6);
    expect(CURATED_MODELS.filter((m) => m.modality === 'tts' || m.modality === 'stt').length).toBe(3);
    expect(new Set(CURATED_MODELS.map((m) => m.id)).size).toBe(CURATED_MODELS.length);
  });

  it('includes the newly verified local Ollama models with accurate tags and capabilities', () => {
    const expected = [
      ['mimo-v2-6-9b', 'mimo-v2.6:9b', 9, 256_000, 'Xiaomi', true, true, true],
      ['flint-40b', 'flint:40b', 39.8, 256_000, 'Recursive', true, false, true],
      // 128000 on its model card; its file's context_length is 65536, and the catalog caps it there.
      ['nemotron-3-5-bolt-e4b', 'nemotron-3.5-bolt:e4b', 4, 65_536, 'NVIDIA', true, true, true],
      ['lfm3-1-7b', 'lfm3:1.7b', 1.7, 256_000, 'Liquid AI', true, false, true],
    ] as const;

    for (const [id, tag, params, contextWindow, creator, reasoning, vision, tools] of expected) {
      const model = byId.get(id);
      expect(model, id).toBeDefined();
      expect(model).toMatchObject({
        backend: 'ollama',
        backendModelId: tag,
        parameterScale: params,
        runtime: { contextWindow, reasoning, quantization: 'q4_K_M' },
        metadata: { creator, capabilities: { reasoning, vision, tools, audio: false } },
      });
    }
    expect(byId.get('flint-40b')?.activeParameterScale).toBe(2.5);
    // Download sizes come from the registry's files (kv-geometry.generated.ts), within 10 % of the TOON's gb column.
    for (const [id, gb] of [
      ['mimo-v2-6-9b', 6.6],
      ['flint-40b', 23],
      ['nemotron-3-5-bolt-e4b', 7.9],
      ['lfm3-1-7b', 1.1],
    ] as const) {
      expect(byId.get(id)?.requirements.diskMb, id).toBe(fileMb(id));
      expect(Math.abs((fileMb(id) ?? 0) / (gb * 1024) - 1), id).toBeLessThan(0.1);
    }
  });

  // 2026-11-15 refresh (see the note above CATALOG_TOON). Each row's tag, size, and architecture were read
  // from registry.ollama.ai manifests, config blobs, and ranged GGUF headers (or, for `hf.co/` rows, Hugging
  // Face's Ollama manifest and the GGUF in its file tree), and every row was re-derived by a second pass;
  // nothing was pulled or loaded.
  it('includes the 2026-11-15 rows with accurate tags, windows, and capabilities', () => {
    const expected = [
      // id, tag, params, context window (the GGUF's context_length caps it), creator, reasoning, vision, tools, gb
      ['ripple-preview-65b', 'ripple-preview:65b', 65, 1_000_000, 'Ricursive', true, false, true, 38.8],
      ['nemotron-3-5-super-120b', 'nemotron-3.5-super:120b', 120, 1_000_000, 'NVIDIA', true, true, true, 90.2],
      ['granite4-2-3b', 'granite4.2:3b', 3, 128_000, 'IBM', true, false, true, 2.2],
      ['granite4-2-8b', 'granite4.2:8b', 8, 128_000, 'IBM', true, false, true, 5.3],
      ['granite4-2-30b', 'granite4.2:30b', 30, 128_000, 'IBM', true, false, true, 17.7],
      ['lfm3-vl-2b', 'lfm3-vl:2b', 1.92, 128_000, 'Liquid AI', true, true, true, 1.5],
      ['lfm2-5-24b', 'lfm2.5:24b', 24, 128_000, 'Liquid AI', true, false, true, 14.5],
      ['ornith-1-5-122b', 'ornith-1.5:122b', 122, 256_000, 'Deep Reinforce', true, true, true, 76.8],
      ['nemotron-cascade-2-30b', 'nemotron-cascade-2:30b', 30, 256_000, 'NVIDIA', true, false, true, 24.3],
      ['mistral-medium-3-5-128b', 'mistral-medium-3.5:128b', 128, 256_000, 'Mistral', true, true, true, 80.2],
      // No bare default tag exists for this family, so the q4_K_M GGUF is named explicitly.
      ['qwen3-8-flash-next-125b', 'qwen3.8-flash-next:125b-a6b-q4_K_M', 125, 256_000, 'Alibaba', true, true, true, 120.1],
      // Community re-host on Ollama's registry: one merged UD-Q4_K_M blob (Mistral Small 4 has no library page).
      ['mistral-small-4-119b', 'frob/mistral-small-4:119b', 119, 256_000, 'Mistral', true, true, true, 74.6],
      // Single-file Hugging Face GGUFs; Arete's size includes the vision projector that its pull also fetches.
      ['nanbeige4-3-33b', 'hf.co/bartowski/Nanbeige_Nanbeige4.3-33B-GGUF:Q4_K_M', 33, 512_000, 'Nanbeige', true, false, true, 20.8],
      ['arete-27b', 'hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M', 27, 262_000, 'Nous Research', true, true, true, 18.1],
      // The vendor's own Ollama namespace; the library page shows a vision badge only.
      ['minicpm-v4-7-35b-a3b', 'openbmb/minicpm-v4.7:35b-a3b', 35, 256_000, 'OpenBMB', false, true, false, 22.3],
      ['minicpm-v4-7-1b', 'openbmb/minicpm-v4.7:1b', 1, 256_000, 'OpenBMB', false, true, false, 1.8],
    ] as const;

    for (const [id, tag, params, contextWindow, creator, reasoning, vision, tools, gb] of expected) {
      const model = byId.get(id);
      expect(model, id).toBeDefined();
      expect(model).toMatchObject({
        backend: 'ollama',
        backendModelId: tag,
        parameterScale: params,
        runtime: { contextWindow, reasoning, quantization: 'q4_K_M' },
        metadata: { creator, capabilities: { reasoning, vision, tools, audio: false } },
      });
      // The size comes from the registry's file (kv-geometry.generated.ts). `gb` above restates the figure on the row's TOON line
      // (decimal GB, one decimal), which the runtime uses only for a row with no file entry; this test cannot read the TOON,
      // so a typo there is not caught.
      expect(model?.requirements.diskMb, id).toBe(fileMb(id));
      expect(Math.abs((GGUF_KV_GEOMETRY[id]?.fileBytes ?? 0) / 1e9 - gb), id).toBeLessThan(0.05);
      // New rows carry no Artificial Analysis figures: its index moved to v5.0.1 and this column is on v4.3.
      expect(model?.metadata?.intelligenceIndex, id).toBeUndefined();
    }

    // Mixture-of-experts rows state their active size (vendor figure, or the GGUF's expert counts).
    for (const [id, active] of [
      ['nemotron-3-5-super-120b', 12],
      ['lfm2-5-24b', 2.45],
      ['ornith-1-5-122b', 10],
      ['ornith-1-5-397b', 17],
      ['nemotron-cascade-2-30b', 3],
      ['qwen3-8-flash-next-125b', 6],
      ['mistral-small-4-119b', 6.5],
      ['minicpm-v4-7-35b-a3b', 3],
    ] as const) {
      expect(byId.get(id)?.activeParameterScale, id).toBe(active);
    }
    // Dense rows keep their full parameter count.
    for (const id of ['ripple-preview-65b', 'granite4-2-30b', 'mistral-medium-3-5-128b', 'arete-27b']) {
      expect(byId.get(id)?.activeParameterScale, id).toBe(byId.get(id)?.parameterScale);
    }
  });

  // The ornith-1.5 library page showed only a vision badge on 2026-08-29, so those flags were left unset; it now
  // shows vision + tools + thinking, as the vendor cards say, and the 122B row was added with all three.
  it('flags every Ornith 1.5 row as a reasoning, tool-calling, vision model, and the 35B, 122B, and 397B as MoE', () => {
    for (const id of ['ornith-1-5-9b', 'ornith-1-5-35b', 'ornith-1-5-122b', 'ornith-1-5-397b']) {
      expect(byId.get(id)?.metadata?.capabilities, id).toEqual({ reasoning: true, vision: true, tools: true, audio: false });
    }
    expect(byId.get('ornith-1-5-35b')?.activeParameterScale).toBe(3);
    expect(byId.get('ornith-1-5-122b')?.activeParameterScale).toBe(10);
    expect(byId.get('ornith-1-5-397b')?.activeParameterScale).toBe(17);
  });

  // The 2026-08-29 note kept this family out for lack of a GGUF tag; the explicit q4_K_M tag exists.
  it('lists Qwen 3.8 Flash-Next through its llama.cpp GGUF, not the MLX or NVFP4 tags', () => {
    const flashNext = byId.get('qwen3-8-flash-next-125b');
    expect(flashNext?.backendModelId).toBe('qwen3.8-flash-next:125b-a6b-q4_K_M');
    expect(flashNext?.backendModelId).not.toMatch(/mlx|nvfp4/i);
    expect(GGUF_KV_GEOMETRY['qwen3-8-flash-next-125b']?.architecture).toBe('qwen4exp');
    expect(flashNext?.requirements.gpuVendors).toEqual(['nvidia', 'amd', 'apple', 'cpu']);
  });

  // The 2026-11-15 oMLX rows mirror an Ollama row (params, creator, purpose, reasoning, tools, and tier), and say so
  // in their id (`<ollama id>-mlx`). The table pins each row's repo, download size (gb), window (ctxK), and vision
  // flag: for an oMLX row `gb` alone sizes the memory
  // requirements and, with no scores to rank on, decides which row a given Mac is offered first.
  it('mirrors each 2026-11-15 oMLX row on its Ollama partner and pins its repo, size, window, and vision flag', () => {
    const expected = [
      // id, repo, gb, ctxK, vision
      ['laguna-s-2-1-mlx', 'mlx-community/Laguna-S-2.1-oQ4e', 64.1, 256, false],
      ['ornith-9b-mlx', 'mlx-community/Ornith-1.0-9B-4bit', 6.0, 256, true],
      ['ornith-35b-mlx', 'mlx-community/Ornith-1.0-35B-4bit', 20.4, 256, true],
      ['ornith-1-5-9b-mlx', 'mlx-community/Ornith-1.5-9B-OptiQ-4bit', 7.1, 256, false],
      ['ornith-1-5-35b-mlx', 'mlx-community/Ornith-1.5-35B-A3B-OptiQ-4bit', 23.5, 256, true],
      ['mimo-v2-6-9b-mlx', 'mlx-community/MiMo-V2.6-Distill-Qwen-9B-OptiQ-4bit', 7.1, 256, false],
      ['flint-40b-mlx', 'mlx-community/flint-oQ4e', 23.4, 256, false],
      ['nemotron-3-5-bolt-e4b-mlx', 'mlx-community/NVIDIA-Nemotron-3.5-Bolt-E4B-OptiQ-4bit', 7.5, 64, true],
      ['lfm3-1-7b-mlx', 'mlx-community/LFM3-1.7B-OptiQ-4bit', 1.3, 256, false],
      ['lfm3-vl-2b-mlx', 'mlx-community/LFM3-VL-2B-OptiQ-4bit', 1.7, 128, true],
      ['lfm2-5-24b-mlx', 'mlx-community/LFM2.5-24B-A2B-OptiQ-4bit', 16.7, 128, false],
      ['qwen3-8-flash-next-125b-mlx', 'mlx-community/Qwen3.8-Flash-Next-4bit', 111.5, 256, true],
    ] as const;
    for (const [id, repo, gb, ctxK, vision] of expected) {
      const mlx = byId.get(id);
      const partner = byId.get(id.replace(/-mlx$/, ''));
      expect(mlx?.backend, id).toBe('omlx');
      expect(partner?.backend, `${id} partner`).toBe('ollama');
      expect(mlx?.parameterScale, id).toBe(partner?.parameterScale);
      expect(mlx?.metadata?.creator, id).toBe(partner?.metadata?.creator);
      expect(mlx?.purpose, id).toBe(partner?.purpose);
      expect(mlx?.activeParameterScale, id).toBe(partner?.activeParameterScale);
      expect(mlx?.metadata?.capabilities?.reasoning, id).toBe(partner?.metadata?.capabilities?.reasoning);
      expect(mlx?.metadata?.capabilities?.tools, id).toBe(partner?.metadata?.capabilities?.tools);
      expect(mlx?.requirements.minTier, id).toBe(partner?.requirements.minTier);
      expect(mlx, id).toMatchObject({ backendModelId: repo, runtime: { contextWindow: ctxK * 1000 }, metadata: { capabilities: { vision } } });
      expect(mlx?.requirements.diskMb, id).toBe(Math.round(gb * 1024));
      // 4-bit weights cost about half a byte to one byte a parameter (more for a small row with a large embedding
      // table or a vision tower), so a slipped decimal point in `gb` shows here.
      expect(gb / (mlx?.parameterScale ?? 1), id).toBeGreaterThan(0.4);
      expect(gb / (mlx?.parameterScale ?? 1), id).toBeLessThan(2);
    }
  });

  it('lists the five 2026-11-15 vLLM rows as bf16 builds of their Hugging Face repos, sized by their shards', () => {
    const expected = [
      // id, repo, gb (the summed bf16 safetensors), params, active params for a MoE row, ctxK, vision
      ['qwen3-8-27b-vllm', 'Qwen/Qwen3.8-27B', 55.6, 27, undefined, 262, true],
      ['qwen3-6-35b-vllm', 'Qwen/Qwen3.6-35B-A3B', 71.9, 35, 3, 262, true],
      ['gemma4-31b-vllm', 'google/gemma-4-31B-it', 62.5, 31, undefined, 256, true],
      ['qwen3-5-9b-vllm', 'Qwen/Qwen3.5-9B', 19.3, 9, undefined, 262, true],
      ['glm-4-7-flash-30b-vllm', 'zai-org/GLM-4.7-Flash', 62.4, 30, 3, 202, false],
    ] as const;
    for (const [id, repo, gb, params, active, ctxK, vision] of expected) {
      const row = byId.get(id);
      expect(row, id).toMatchObject({
        backend: 'vllm',
        backendModelId: repo,
        parameterScale: params,
        runtime: { quantization: 'bf16', contextWindow: ctxK * 1000 },
        metadata: { capabilities: { vision } },
      });
      expect(row?.requirements.diskMb, id).toBe(Math.round(gb * 1024));
      // bf16 weights are two bytes a parameter, give or take a vision tower or an embedding table.
      expect(gb / params, id).toBeGreaterThan(1.9);
      expect(gb / params, id).toBeLessThan(2.3);
      expect(row?.activeParameterScale, id).toBe(active ?? params);
    }
  });

  // The Hub suggests a plain `vllm serve <repo>`, which cannot fetch a repo that asks for a Hugging Face token.
  it('keeps meta-llama and pre-4 Gemma repos, which ask for a token, out of the vLLM table', () => {
    for (const m of llms.filter((row) => row.backend === 'vllm')) {
      expect(m.backendModelId, `${m.id} is gated`).not.toMatch(/^meta-llama\/|^google\/gemma-(?!4)/);
    }
  });

  it('declares the native host platform matrix for every curated backend', () => {
    const expectedByBackend = {
      ollama: ['darwin', 'linux', 'win32'],
      lemonade: ['darwin', 'linux', 'win32'],
      vllm: ['linux', 'win32'],
      omlx: ['darwin'],
    } as const;

    for (const model of CURATED_MODELS) {
      expect(model.requirements.supportedPlatforms, `${model.id} platform matrix`).toEqual(expectedByBackend[model.backend]);
    }

    expect(llms.filter((m) => m.backend === 'omlx').every((m) => m.requirements.supportedPlatforms?.includes('darwin'))).toBe(true);
    expect(llms.filter((m) => m.backend === 'vllm').every((m) => !m.requirements.supportedPlatforms?.includes('darwin'))).toBe(true);
  });

  it('leaves every row without a ramGb column on the historical diskMb x 1.1 footprint, or a Lemonade or Ollama row on its files', () => {
    // Regression guard for the optional `ramGb` column: only a row that states a measured figure
    // may leave the derived numbers, so adding one must not shift any other row.
    const measured = CURATED_MODELS.filter((m) => m.runtime.footprintMeasured).map((m) => m.id);
    expect(measured.sort()).toEqual(['gemma4-26b', 'gemma4-31b', 'gemma4-e4b', 'qwen3-8-27b-lemonade']);
    for (const m of CURATED_MODELS.filter((m) => m.modality === 'llm' && !m.runtime.footprintMeasured)) {
      expect(m.runtime, `${m.id} runtime`).not.toHaveProperty('footprintMeasured');
      const fileBytes = m.backend === 'lemonade' || m.backend === 'ollama' ? GGUF_KV_GEOMETRY[m.id]?.fileBytes : undefined;
      expect(m.runtime.memoryFootprintMb, `${m.id} footprint`).toBe(
        fileBytes ? Math.ceil(fileBytes / 1024 ** 2 + 768) : Math.round(m.requirements.diskMb * 1.1),
      );
      expect(m.requirements.minVramMb, `${m.id} minVram`).toBe(m.requirements.diskMb);
      expect(m.requirements.recommendedVramMb, `${m.id} recVram`).toBe(
        fileBytes ? m.runtime.memoryFootprintMb + 1024 : Math.round(m.requirements.diskMb * 1.1 + 1024),
      );
      expect(m.requirements.minRamMb, `${m.id} minRam`).toBe(Math.round(m.requirements.diskMb * 1.15));
    }
  });

  // The 10 % rule put the same-size Qwen 3.5 27B 2.4 GB above Qwen 3.8 27B's measured 18,473 MB.
  it("charges an unmeasured Lemonade or Ollama row its files plus the runner's overhead", () => {
    const footprint = (id: string) => CURATED_MODELS.find((m) => m.id === id)?.runtime.memoryFootprintMb;
    expect(footprint('qwen3-5-27b-lemonade')).toBe(18_458);
    expect(footprint('qwen3-8-27b-lemonade')).toBe(18_473); // measured: left alone
    const ollama = CURATED_MODELS.find((m) => m.id === 'qwen3-5-27b');
    expect(footprint('qwen3-5-27b')).toBe(Math.ceil((GGUF_KV_GEOMETRY['qwen3-5-27b']?.fileBytes ?? 0) / 1024 ** 2 + 768)); // Ollama: its registry files
    expect(ollama?.requirements.diskMb).toBe(fileMb('qwen3-5-27b'));
  });

  // Lemonade refused every 58k-token prompt to Qwen3-8B (2026-11-10): its file runs at 40960, and the
  // 131072 on the row needs YaRN, which neither engine switches on. The Hub would have handed out 64k.
  it("caps a row's window at its file's context_length, and leaves one inside it alone", () => {
    const window = (id: string) => byId.get(id)?.runtime.contextWindow;
    expect(window('qwen3-8b-lemonade')).toBe(40_960);
    expect(window('qwen3-4b-lemonade')).toBe(40_960);
    expect(window('command-a-111b')).toBe(16_384);
    expect(window('qwen3-8-27b-lemonade')).toBe(256_000); // inside its file's 262144: unchanged
    for (const m of CURATED_MODELS) {
      const fileWindow = GGUF_KV_GEOMETRY[m.id]?.contextLength;
      if (fileWindow) expect(m.runtime.contextWindow, m.id).toBeLessThanOrEqual(fileWindow);
    }
  });

  it('gives every model a real, pullable backend tag and sane derived requirements', () => {
    for (const m of CURATED_MODELS) {
      expect(m.backendModelId, `${m.id} backendModelId`).toBeTruthy();
      expect(m.requirements.diskMb, `${m.id} diskMb`).toBeGreaterThan(0);
      expect(m.runtime.memoryFootprintMb, `${m.id} footprint`).toBeGreaterThan(0);
    }
    // Ollama LLM tags are the bare `family:size` default (the q4_K_M build ollama pulls by default).
    for (const m of llms.filter((m) => m.backend === 'ollama')) {
      expect(m.backendModelId, `${m.id} tag`).toContain(':');
      expect(m.runtime.quantization).toBe('q4_K_M');
    }
    // Lemonade LLM tags are the exact registry key from server_models.json (no colon-tag convention).
    for (const m of llms.filter((m) => m.backend === 'lemonade')) {
      expect(m.backendModelId, `${m.id} tag`).not.toContain(':');
      // Stated per row from the Lemonade checkpoint tag (see the LEMONADE_LLM_TOON comment).
      expect(m.runtime.quantization, `${m.id} quantization`).toMatch(/^(ud-)?q4_(0|1|K_M|K_S|K_XL)$|^mxfp4$/);
    }
    for (const m of llms.filter((m) => m.backend === 'vllm')) {
      expect(m.backendModelId, `${m.id} tag`).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(['bf16', 'mxfp4'], `${m.id} quantization`).toContain(m.runtime.quantization);
    }
    for (const m of llms.filter((m) => m.backend === 'omlx')) {
      expect(m.backendModelId, `${m.id} tag`).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(['mlx-4bit', 'mlx-8bit', 'mlx-2.4bit', 'mxfp4'], `${m.id} quantization`).toContain(m.runtime.quantization);
    }
  });

  // The Hub finds an oMLX row among oMLX's listing by the model's own name (`omlxModelsMatch`): oMLX lists a model by its
  // directory or as `<org>--<name>`, never as the repo id. That holds while a repo id has no `--` (Hugging Face bars it,
  // and a cache id splits on the first one) and no two rows share a model name under different organizations.
  it('keeps every oMLX row apart by the model name oMLX lists it under', () => {
    const rows = llms.filter((m) => m.backend === 'omlx');
    const owners = new Map<string, string>();
    for (const m of rows) {
      expect(m.backendModelId, `${m.id} repo id`).not.toContain('--');
      const name = omlxModelKey(m.backendModelId);
      expect(owners.get(name), `${m.id} shares its model name with ${owners.get(name)}`).toBeUndefined();
      owners.set(name, m.id);
    }
    expect(owners.size).toBe(rows.length);
  });

  it('gates oMLX rows to Apple Silicon only, never an NVIDIA VRAM budget', () => {
    const mlxRows = llms.filter((m) => m.backend === 'omlx');
    expect(mlxRows.length).toBe(76);
    for (const m of mlxRows) {
      expect(m.backendModelId, `${m.id} tag`).toMatch(/^mlx-community\//);
      expect(m.requirements.gpuVendors, `${m.id} gpuVendors`).toEqual(['apple']);
    }
    // The plain (CUDA) vLLM rows are unaffected — still NVIDIA-only.
    const cudaRows = llms.filter((m) => m.backend === 'vllm' && !m.id.endsWith('-mlx'));
    for (const m of cudaRows) {
      expect(m.requirements.gpuVendors, `${m.id} gpuVendors`).toEqual(['nvidia']);
    }
    // Spans low/medium/high like the CUDA table, so Macs of different unified-memory sizes get a fit.
    expect(mlxRows.some((m) => m.requirements.minTier === 'low')).toBe(true);
    expect(mlxRows.some((m) => m.requirements.minTier === 'medium')).toBe(true);
    expect(mlxRows.some((m) => m.requirements.minTier === 'high')).toBe(true);
    // MoE row carries active-params so hardware-fit ranking doesn't treat it as dense.
    expect(byId.get('qwen3-30b-a3b-mlx')?.activeParameterScale).toBe(3);
  });

  it('surfaces vLLM chat models so selecting the vLLM backend yields usable recommendations', () => {
    const vllm = llms.filter((m) => m.backend === 'vllm');
    // At least one per hardware tier the backend realistically serves (GPU boxes).
    expect(vllm.some((m) => m.requirements.minTier === 'low')).toBe(true);
    expect(vllm.some((m) => m.requirements.minTier === 'medium')).toBe(true);
    expect(vllm.some((m) => m.requirements.minTier === 'high')).toBe(true);
    // MoE rows carry active-params so the hardware-fit ranking doesn't treat them as dense.
    const coder = byId.get('qwen3-coder-30b-vllm');
    expect(coder?.activeParameterScale).toBe(3);
  });

  it('derives requirements + context from the TOON row (gemma4-12b)', () => {
    const g = byId.get('gemma4-12b');
    expect(g).toBeDefined();
    expect(g?.backendModelId).toBe('gemma4:12b');
    expect(g?.parameterScale).toBe(12);
    // Nothing measured: its download is its registry files (7,650 MiB; the TOON's gb=7.6 said 7,782), and its
    // footprint those files plus the runner's 768 MB, the base the load estimate charges once it is pulled.
    expect(g?.requirements.diskMb).toBe(7_650);
    expect(g?.runtime.memoryFootprintMb).toBe(7_650 + 769);
    expect(g?.runtime.footprintMeasured).toBeUndefined();
    // ctxK=256 → 256000 (not the 131072 default).
    expect(g?.runtime.contextWindow).toBe(256000);
  });

  // The fleet's measurements, 2026-09-30 (see the note above CATALOG_TOON): the engine process less
  // its KV cache and compute buffers. The disk figure stays the download, which is what a pull writes.
  it.each([
    // id, measured footprint MB, download MB
    ['gemma4-e4b', 4_362, 6_279],
    ['gemma4-26b', 18_780, 17_863],
    ['gemma4-31b', 19_651, 19_441],
  ])('carries the measured footprint of %s and takes its download from the registry files', (id, footprintMb, diskMb) => {
    const m = byId.get(id);
    expect(m?.runtime.memoryFootprintMb).toBe(footprintMb);
    expect(m?.runtime.footprintMeasured).toBe(true);
    expect(m?.requirements.diskMb).toBe(diskMb);
    expect(m?.requirements.minVramMb).toBe(footprintMb);
    expect(m?.requirements.recommendedVramMb).toBe(footprintMb + 1024);
    expect(m?.requirements.minRamMb).toBe(Math.round(footprintMb * 1.05));
  });

  // Its load logs suggest about 2,925 MB (e4b's reading less the weight difference), but no node has
  // held it to read, and the column is for readings. A derived 2,925 made it the auto-installed default
  // on 4 GB cards (a 7.2 GB download the load estimate then refused there); model-registry pins that.
  // It is charged its files instead — the tag shrank to 4,375 MiB — plus the runner's 768: what the load
  // estimate charges once it is pulled, so the two cannot disagree, and still over a 4 GB card.
  it('keeps gemma4 E2B unmeasured, on its files plus the runner, where the load estimate charges it', () => {
    const e2b = byId.get('gemma4-e2b');
    expect(e2b?.runtime.footprintMeasured).toBeUndefined();
    expect(e2b?.requirements.diskMb).toBe(4_375);
    expect(e2b?.runtime.memoryFootprintMb).toBe(5_143);
  });

  it('puts gemma4 E4B under its download, never raised back to it', () => {
    const e4b = byId.get('gemma4-e4b');
    // 10,813 MB when derived from the 9.6 GB download it once was; weights, encoders and runtime hold 4,046-4,357 MiB.
    expect(e4b?.runtime.memoryFootprintMb).toBe(4_362);
    expect(e4b?.runtime.memoryFootprintMb).toBeLessThan(e4b?.requirements.diskMb ?? 0);
  });

  // F7 in the #1679 audit: the row carried 17.2, its files measured in GiB, where every other Lemonade
  // row carries the registry's size. The measurement now sets the footprint through `ramGb` instead.
  it('runs only the measured Lemonade 27B with a q8_0 KV cache', () => {
    const quantized = CURATED_MODELS.filter((m) => m.runtime.kvCacheType).map((m) => m.id);
    expect(quantized).toEqual(['qwen3-8-27b-lemonade']);
    // The per-token figure stays the 16-bit one: the engine scales it when it applies the type.
    expect(byId.get('qwen3-8-27b-lemonade')?.runtime.kvMbPerToken).toBe(0.0667);
  });

  // Lemonade's registry states 18.8; the files it downloads (weights and projector) are 17,630 MiB.
  it("gives qwen3-8-27b-lemonade its files' 17,630 MiB and its measured footprint", () => {
    const m = byId.get('qwen3-8-27b-lemonade');
    expect(m?.requirements.diskMb).toBe(17_630);
    // 19,017 MiB held at 8192 tokens, less 0.0667 MiB/token of KV for that window.
    expect(m?.runtime.memoryFootprintMb).toBe(18_473);
    expect(m?.runtime.footprintMeasured).toBe(true);
    expect(m?.runtime.kvMbPerToken).toBe(0.0667);
  });

  it('carries Artificial Analysis metadata for leaderboard models', () => {
    const llama = byId.get('llama3-3-70b');
    expect(llama?.metadata?.creator).toBe('Meta');
    // Artificial Analysis, re-pulled 2026-09-29 (see the catalog header).
    expect(llama?.metadata?.intelligenceIndex).toBe(7.7);
    expect(llama?.metadata?.perf?.tokensPerSec).toBe(89);

    const gemma = byId.get('gemma4-31b');
    expect(gemma?.metadata?.creator).toBe('Google');
    expect(gemma?.metadata?.capabilities?.vision).toBe(true);
  });

  it('lists the official MTP builds as separate rows that inherit their base row', () => {
    // Same q4_K_M weights plus the trained multi-token-prediction head: Ollama's llama-server drafts
    // from it and rejection-samples, so output is identical and the leaderboard columns are inherited.
    // Separate rows on purpose (the user sees which build they run), so the ids must NOT share the
    // quant-suffix shape the recommender collapses.
    const pairs: Array<[string, string, string]> = [
      ['qwen3-6-27b-mtp', 'qwen3-6-27b', 'qwen3.6:27b-mtp-q4_K_M'],
      ['qwen3-6-35b-mtp', 'qwen3-6-35b', 'qwen3.6:35b-a3b-mtp-q4_K_M'],
      ['qwen3-8-27b-mtp', 'qwen3-8-27b', 'qwen3.8:27b-mtp-q4_K_M'],
      ['gemma4-26b-mtp', 'gemma4-26b', 'gemma4:26b-a4b-it-mtp-q4_K_M'],
    ];
    for (const [mtpId, baseId, tag] of pairs) {
      const mtp = byId.get(mtpId);
      const base = byId.get(baseId);
      expect(mtp, mtpId).toBeDefined();
      expect(base, baseId).toBeDefined();
      expect(mtp?.backendModelId).toBe(tag);
      expect(mtp?.backend).toBe('ollama');
      expect(mtp?.displayName).toContain('(MTP)');
      expect(mtp?.parameterScale).toBe(base?.parameterScale);
      expect(mtp?.activeParameterScale).toBe(base?.activeParameterScale);
      expect(mtp?.metadata?.intelligenceIndex).toBe(base?.metadata?.intelligenceIndex);
      expect(mtp?.metadata?.capabilities).toEqual(base?.metadata?.capabilities);
      expect(mtp?.runtime.contextWindow).toBe(base?.runtime.contextWindow);
      // The MTP tag is its own download, at least as large (the registry now serves some base tags as the MTP
      // build itself); the size column must be the tag's, not the base's.
      expect(mtp?.requirements.diskMb).toBeGreaterThanOrEqual(base?.requirements.diskMb ?? Number.POSITIVE_INFINITY);
    }
  });

  it('sets creator + capabilities on every LLM, even those off the leaderboard', () => {
    for (const m of llms) {
      expect(m.metadata?.creator, `${m.id} creator`).toBeTruthy();
      expect(m.metadata?.capabilities, `${m.id} capabilities`).toBeDefined();
      // Reasoning capability mirrors the runtime flag.
      expect(m.metadata?.capabilities?.reasoning).toBe(m.runtime.reasoning);
    }
  });

  it('includes GLM 5.2 in the large-models browse group', () => {
    const glm = byId.get('glm-5-2');
    expect(glm).toBeDefined();
    expect(glm?.backendModelId).toBe('hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL');
    expect(glm?.parameterScale).toBeGreaterThan(70);
    expect(glm?.tiers.high).toBe('recommended');
  });

  it('derives requirements + metadata for Muse Glimmer', () => {
    const muse = byId.get('muse-glimmer-30b');
    expect(muse).toBeDefined();
    expect(muse?.backendModelId).toBe('muse-glimmer:30b');
    expect(muse?.metadata?.creator).toBe('Meta');
    expect(muse?.metadata?.capabilities?.vision).toBe(true);
    expect(muse?.metadata?.capabilities?.tools).toBe(true);
    expect(muse?.metadata?.capabilities?.reasoning).toBe(true);
    expect(muse?.requirements.diskMb).toBe(fileMb('muse-glimmer-30b'));
    expect(muse?.tiers.medium).toBe('recommended');
  });

  it('derives requirements + metadata for Nemotron 3.5 Lightning', () => {
    const nemotron = byId.get('nemotron-3-5-lightning-30b');
    expect(nemotron).toBeDefined();
    expect(nemotron?.backendModelId).toBe('nemotron-3.5-lightning:30b');
    expect(nemotron?.metadata?.creator).toBe('NVIDIA');
    expect(nemotron?.activeParameterScale).toBe(3);
    expect(nemotron?.requirements.diskMb).toBe(fileMb('nemotron-3-5-lightning-30b'));
    expect(nemotron?.tiers.medium).toBe('recommended');
  });

  it('never surfaces a cloud-proxy (`:cloud`-tagged) model — this catalog is local-only', () => {
    // Checked across every modality, not just LLMs — the rule is about the whole catalog.
    for (const m of CURATED_MODELS) {
      expect(m.backendModelId.endsWith(':cloud'), `${m.id} must not be a :cloud proxy`).toBe(false);
    }
  });

  it('contains no fabricated families/sizes (only ollama.com-verified entries)', () => {
    // Checked against BOTH the catalog `id` and the actual `backendModelId` pull tag — a model once slipped
    // back into the catalog (2026-08) under a dashed `id` (`mistral-medium-3-5-128b`) that dodged an id-only
    // check, while its `backendModelId` (`mistral-medium-3.5:128b`) was still exactly the banned string. Never
    // check id alone again. (Mistral Medium 3.5 left this list on 2026-11-15: the model is real, see below.)
    const ids = new Set(CURATED_MODELS.map((m) => m.id));
    const backendModelIds = CURATED_MODELS.map((m) => m.backendModelId);
    for (const fake of [
      'gemma4-300b',
      'gemma4-800b',
      'gemma4-3t',
      'qwen3-6-200b',
      'kimi-k2-6',
      'deepseek-v4-pro',
      'hermes-4',
      'seed-oss',
      'ernie-4.5',
    ]) {
      expect(ids.has(fake), `fabricated model ${fake} must not exist as an id`).toBe(false);
      const backendHit = backendModelIds.find((tag) => tag === fake || tag.startsWith(`${fake}:`));
      expect(backendHit, `fabricated model ${fake} must not exist as a backendModelId (found: ${backendHit})`).toBeUndefined();
    }
  });

  // 2026-07-27 audit: these were added on 2026-07-27 from the agent's own "any other modern model" web
  // research (not a direct user request), then removed the same day after a follow-up audit caught this
  // session's web tools fabricating convincing, internally-consistent pages for known-fake models (see the
  // fabrication guard above) and, separately, found one of these rows' fetched description self-referencing
  // an Anthropic-internal codename it had no legitimate way to know. None of them were confirmed to exist
  // through a channel independent of this session's own fetch tooling. Do not re-add without that
  // independent confirmation (a real browser, or an actual successful `ollama pull`). (granite4-1-3b/8b/30b and
  // lfm2-24b turned out to be real, per registry manifests read on 2026-11-15; they stay out because granite4.2
  // and lfm2.5:24b supersede them.)
  it('does not re-add the 2026-07-27 unverified/likely-fabricated batch', () => {
    const ids = new Set(CURATED_MODELS.map((m) => m.id));
    for (const unverified of [
      'kimi-k3-cloud',
      'granite4-1-3b',
      'granite4-1-8b',
      'granite4-1-30b',
      'glm-5-1-cloud',
      'minimax-m3-cloud',
      'lfm2-24b',
      'qwen3-fable-4b',
      'qwen3-fable-8b',
    ]) {
      expect(ids.has(unverified), `unverified model ${unverified} must not be re-added without independent confirmation`).toBe(false);
    }
  });

  // 2026-08-12 removed Mistral Medium 3.5 as unconfirmed, and this slot used to forbid it. It is real, and
  // the proof does not depend on a fetch summary (the 2026-07-27 failure mode): on 2026-11-15
  // registry.ollama.ai served `mistral-medium-3.5:128b` with manifest layers that sum to 80,241,474,657 bytes (config
  // `file_type` Q4_K_M, no cloud or remote field), whose GGUF header reads arch `mistral3`, 88 blocks, context_length 262144;
  // mistralai/Mistral-Medium-3.5-128B on Hugging Face was created 2026-03-31, before either removal, with a
  // public history from 2026-04-29; and Artificial Analysis lists it as an open-weights Mistral model. The
  // geometry table below is generated from that same manifest and header, so a mismatch here means the
  // registry changed, not that someone typed a number.
  it('lists Mistral Medium 3.5 on the strength of its registry manifest and GGUF header', () => {
    const m = byId.get('mistral-medium-3-5-128b');
    expect(m).toMatchObject({ backend: 'ollama', backendModelId: 'mistral-medium-3.5:128b', metadata: { creator: 'Mistral' } });
    expect(GGUF_KV_GEOMETRY['mistral-medium-3-5-128b']).toMatchObject({
      architecture: 'mistral3',
      fileBytes: 80_241_474_657,
      contextLength: 262_144,
    });
  });

  // 2026-11-15: real models that are not listed because Ollama cannot pull them. For a sharded Hugging Face
  // GGUF, `ollama pull hf.co/<repo>:<quant>` asks huggingface.co/v2/<repo>/manifests/<quant>, which answers
  // HTTP 400 "This repository only contains sharded GGUF files. Ollama does not yet support pulling sharded
  // GGUF via the registry" to Ollama's User-Agent (single-file repos answer 200). The official and
  // major-quantizer Q4-class builds of these are sharded, and the Hub hands the tag to Ollama's /api/pull
  // unchanged. Re-add one only after an actual pull succeeds. (`glm-5-2` and `inkling` predate this check and
  // fail the same way; they are left as they were, for the Hub owners to decide. Command A+, Muse Spark Open,
  // GLM 5.3 Flash, and MiMo-V2.6 Flash are not listed here because single-file builds of them exist, from
  // individual re-quantizers nobody vetted.)
  it('keeps the eight sharded-only Hugging Face GGUFs seen on 2026-11-15 out of the catalog', () => {
    const ids = new Set(CURATED_MODELS.map((m) => m.id));
    for (const sharded of [
      'kimi-k2-7-code',
      'mimo-v2-6-pro',
      'beam-1-0',
      'nemotron-3-ultra',
      'ling-3-1-flash-1019',
      'k2-horizon-375b',
      'glm-5-3',
      'minimax-m3',
    ]) {
      expect(ids.has(sharded), `${sharded} is sharded-only on Hugging Face: Ollama's pull answers HTTP 400`).toBe(false);
    }
  });

  // An `hf.co/` row has to pass the registry check above before it is listed, so this set changes only on purpose.
  it('lists only the four hf.co/ rows that passed the registry check or predate it', () => {
    const hfRows = CURATED_MODELS.filter((m) => m.backendModelId.startsWith('hf.co/')).map((m) => m.id);
    expect(hfRows.sort()).toEqual(['arete-27b', 'glm-5-2', 'inkling', 'nanbeige4-3-33b']);
  });

  // Lemonade rows are scored like Ollama's: the Intelligence Index describes the model, not the engine
  // (AA evaluates through hosted APIs, never through either), so each takes its Ollama partner's.
  describe('Lemonade intelligence scores', () => {
    const byId = new Map(CURATED_MODELS.map((m) => [m.id, m]));
    const lemonade = CURATED_MODELS.filter((m) => m.backend === 'lemonade' && m.modality === 'llm');

    it("takes every Lemonade row's score from its Ollama partner", () => {
      let scored = 0;
      for (const m of lemonade) {
        const partner = byId.get(m.id.replace(/-lemonade$/, ''));
        if (!partner || m.id === 'qwen3-30b-lemonade') continue;
        expect(m.metadata?.intelligenceIndex, m.id).toBe(partner.metadata?.intelligenceIndex);
        scored += 1;
      }
      expect(scored).toBe(40);
      expect(byId.get('qwen3-8-27b-lemonade')?.metadata?.intelligenceIndex).toBe(33.7);
    });

    it('leaves unscored the row whose partner is a different release', () => {
      // Lemonade serves the original Qwen3-30B-A3B; AA scores it apart from what Ollama's qwen3:30b serves.
      expect(byId.get('qwen3-30b')?.metadata?.intelligenceIndex).toBeDefined();
      expect(byId.get('qwen3-30b-lemonade')?.metadata?.intelligenceIndex).toBeUndefined();
      // gemma4:12b (added 2026-09-29) scores from AA "Gemma 4 12B (Reasoning)"; its Lemonade row inherits it.
      expect(byId.get('gemma4-12b-lemonade')?.metadata?.intelligenceIndex).toBe(14.2);
    });

    it('copies only the score: speed figures are cloud measurements and stay blank', () => {
      for (const m of lemonade) {
        expect(m.metadata?.perf, m.id).toBeUndefined();
      }
    });
  });

  // Every install embeds with nomic v1.5, whichever engine runs it, so an index never strands on a
  // backend switch. Lemonade's registry ships only v1 (cosine ~0.7 against v1.5: a different space).
  it('recommends nomic v1.5 on Lemonade, and the Hub knows how to install it there', () => {
    const lemonadeEmbedders = CURATED_MODELS.filter((m) => m.backend === 'lemonade' && m.modality === 'embedding');
    const recommended = lemonadeEmbedders.filter((m) => Object.values(m.tiers).includes('recommended'));
    expect(recommended.map((m) => m.backendModelId)).toEqual(['nomic-embed-text-v1.5-GGUF']);
    expect(LEMONADE_REGISTRATIONS['nomic-embed-text-v1.5-GGUF']).toMatchObject({ checkpoint: expect.stringContaining('nomic-embed-text-v1.5') });
  });

  // The v1 row was the Lemonade default until 2026-09-29. A host that embedded with it keeps it (see
  // pickEmbeddingModel), so the row must resolve — and must never be recommended to anyone new.
  it('keeps the v1 Lemonade embedder resolvable but never recommends it', () => {
    const v1 = byId.get('nomic-embed-text-v1-lemonade');
    expect(v1?.backendModelId).toBe('nomic-embed-text-v1-GGUF');
    expect(v1?.modality).toBe('embedding');
    expect(Object.values(v1?.tiers ?? {})).not.toContain('recommended');
  });

  // Lemonade looks names up case-sensitively; both 10.2.0 and 2026.39.1 key the Whisper models in
  // title case, so the lowercase ids these rows used to carry could never be served.
  it("names the Whisper rows by Lemonade's registry keys", () => {
    expect(byId.get('whisper-base')?.backendModelId).toBe('Whisper-Base');
    expect(byId.get('whisper-large-v3-turbo')?.backendModelId).toBe('Whisper-Large-v3-Turbo');
  });
});
