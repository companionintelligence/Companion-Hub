import type { CuratedModel, HardwareTier, ModelPurpose } from '@ci-hub/common/types';

// ─── Real Ollama model families ─────────────────────────────────────────────
// Every family + size below is verified to exist on ollama.com/library (checked 2026-05), and the
// `gb` value is the model's actual default (q4_K_M) on-disk size as listed there. The catalog lists
// only the bare `model:size` default tag — the one that is guaranteed to be pullable — so it never
// surfaces a model the user can't actually install. Sizing (RAM/VRAM/disk) is anchored to the real
// file size, not a parameter-count formula, so the installer's footprints match reality.
//
// `p` is the parameter count in billions, used only for best-fit ranking and the CPU size cap.
// `tier` is the lowest hardware tier for which the size is surfaced as a default recommendation.
const FAMILIES: {
  prefix: string;
  idPrefix: string;
  name: string;
  purpose: ModelPurpose;
  sizes: { s: string; idSize: string; p: number; gb: number; tier: HardwareTier }[];
}[] = [
  {
    prefix: 'gemma4',
    idPrefix: 'gemma4',
    name: 'Gemma 4',
    purpose: 'general',
    // ollama.com/library/gemma4 — E2B/E4B edge builds, 26B (MoE, 4B active), 31B dense.
    sizes: [
      { s: 'e2b', idSize: 'e2b', p: 2, gb: 7.2, tier: 'cpu-only' },
      { s: 'e4b', idSize: 'e4b', p: 4, gb: 9.6, tier: 'cpu-only' },
      { s: '26b', idSize: '26b', p: 26, gb: 18, tier: 'medium' },
      { s: '31b', idSize: '31b', p: 31, gb: 20, tier: 'medium' },
    ],
  },
  {
    prefix: 'qwen3.6',
    idPrefix: 'qwen3-6',
    name: 'Qwen 3.6',
    purpose: 'coding',
    // ollama.com/library/qwen3.6 — 27B dense, 35B (MoE, 3B active).
    sizes: [
      { s: '27b', idSize: '27b', p: 27, gb: 17, tier: 'medium' },
      { s: '35b', idSize: '35b', p: 35, gb: 24, tier: 'medium' },
    ],
  },
  {
    prefix: 'qwen3.5',
    idPrefix: 'qwen3-5',
    name: 'Qwen 3.5',
    purpose: 'reasoning',
    // ollama.com/library/qwen3.5
    sizes: [
      { s: '0.8b', idSize: '0-8b', p: 0.8, gb: 1.0, tier: 'cpu-only' },
      { s: '2b', idSize: '2b', p: 2, gb: 2.7, tier: 'cpu-only' },
      { s: '4b', idSize: '4b', p: 4, gb: 3.4, tier: 'cpu-only' },
      { s: '9b', idSize: '9b', p: 9, gb: 6.6, tier: 'low' },
      { s: '27b', idSize: '27b', p: 27, gb: 17, tier: 'medium' },
      { s: '35b', idSize: '35b', p: 35, gb: 24, tier: 'medium' },
      { s: '122b', idSize: '122b', p: 122, gb: 81, tier: 'high' },
    ],
  },
  {
    prefix: 'nemotron3',
    idPrefix: 'nemotron3',
    name: 'Nemotron 3',
    purpose: 'reasoning',
    // ollama.com/library/nemotron3 — 33B (nano/super are separate slugs below).
    sizes: [{ s: '33b', idSize: '33b', p: 33, gb: 28, tier: 'medium' }],
  },
  {
    prefix: 'nemotron-3-nano',
    idPrefix: 'nemotron-3-nano',
    name: 'Nemotron 3 Nano',
    purpose: 'reasoning',
    // ollama.com/library/nemotron-3-nano
    sizes: [
      { s: '4b', idSize: '4b', p: 4, gb: 2.8, tier: 'cpu-only' },
      { s: '30b', idSize: '30b', p: 30, gb: 24, tier: 'medium' },
    ],
  },
  {
    prefix: 'nemotron-3-super',
    idPrefix: 'nemotron-3-super',
    name: 'Nemotron 3 Super',
    purpose: 'reasoning',
    // ollama.com/library/nemotron-3-super — 120B MoE, ~12B active.
    sizes: [{ s: '120b', idSize: '120b', p: 120, gb: 87, tier: 'high' }],
  },
  {
    prefix: 'gpt-oss',
    idPrefix: 'gpt-oss',
    name: 'GPT-OSS',
    purpose: 'general',
    // ollama.com/library/gpt-oss
    sizes: [
      { s: '20b', idSize: '20b', p: 20, gb: 14, tier: 'medium' },
      { s: '120b', idSize: '120b', p: 120, gb: 65, tier: 'high' },
    ],
  },
  {
    prefix: 'deepseek-r1',
    idPrefix: 'deepseek-r1',
    name: 'DeepSeek R1',
    purpose: 'reasoning',
    // ollama.com/library/deepseek-r1
    sizes: [
      { s: '1.5b', idSize: '1-5b', p: 1.5, gb: 1.1, tier: 'cpu-only' },
      { s: '7b', idSize: '7b', p: 7, gb: 4.7, tier: 'low' },
      { s: '8b', idSize: '8b', p: 8, gb: 5.2, tier: 'low' },
      { s: '14b', idSize: '14b', p: 14, gb: 9.0, tier: 'low' },
      { s: '32b', idSize: '32b', p: 32, gb: 20, tier: 'medium' },
      { s: '70b', idSize: '70b', p: 70, gb: 43, tier: 'high' },
      { s: '671b', idSize: '671b', p: 671, gb: 404, tier: 'high' },
    ],
  },
  {
    prefix: 'deepseek-coder-v2',
    idPrefix: 'deepseek-coder-v2',
    name: 'DeepSeek Coder V2',
    purpose: 'coding',
    // ollama.com/library/deepseek-coder-v2 — MoE coding models.
    sizes: [
      { s: '16b', idSize: '16b', p: 16, gb: 8.9, tier: 'medium' },
      { s: '236b', idSize: '236b', p: 236, gb: 133, tier: 'high' },
    ],
  },
  {
    prefix: 'qwen3',
    idPrefix: 'qwen3',
    name: 'Qwen 3',
    purpose: 'general',
    // ollama.com/library/qwen3
    sizes: [
      { s: '0.6b', idSize: '0-6b', p: 0.6, gb: 0.5, tier: 'cpu-only' },
      { s: '1.7b', idSize: '1-7b', p: 1.7, gb: 1.4, tier: 'cpu-only' },
      { s: '4b', idSize: '4b', p: 4, gb: 2.5, tier: 'cpu-only' },
      { s: '8b', idSize: '8b', p: 8, gb: 5.2, tier: 'low' },
      { s: '14b', idSize: '14b', p: 14, gb: 9.3, tier: 'low' },
      { s: '30b', idSize: '30b', p: 30, gb: 19, tier: 'medium' },
      { s: '32b', idSize: '32b', p: 32, gb: 20, tier: 'medium' },
      { s: '235b', idSize: '235b', p: 235, gb: 142, tier: 'high' },
    ],
  },
  {
    prefix: 'qwq',
    idPrefix: 'qwq',
    name: 'QwQ',
    purpose: 'reasoning',
    // ollama.com/library/qwq
    sizes: [{ s: '32b', idSize: '32b', p: 32, gb: 20, tier: 'medium' }],
  },
  {
    prefix: 'gemma3',
    idPrefix: 'gemma3',
    name: 'Gemma 3',
    purpose: 'general',
    // ollama.com/library/gemma3
    sizes: [
      { s: '270m', idSize: '270m', p: 0.27, gb: 0.3, tier: 'cpu-only' },
      { s: '1b', idSize: '1b', p: 1, gb: 0.8, tier: 'cpu-only' },
      { s: '4b', idSize: '4b', p: 4, gb: 3.3, tier: 'cpu-only' },
      { s: '12b', idSize: '12b', p: 12, gb: 8.1, tier: 'low' },
      { s: '27b', idSize: '27b', p: 27, gb: 17, tier: 'medium' },
    ],
  },
  {
    prefix: 'mistral',
    idPrefix: 'mistral',
    name: 'Mistral',
    purpose: 'general',
    // ollama.com/library/mistral — 7B only (Small/Large/Nemo are separate slugs below).
    sizes: [{ s: '7b', idSize: '7b', p: 7, gb: 4.4, tier: 'low' }],
  },
  {
    prefix: 'mistral-nemo',
    idPrefix: 'mistral-nemo',
    name: 'Mistral Nemo',
    purpose: 'general',
    // ollama.com/library/mistral-nemo
    sizes: [{ s: '12b', idSize: '12b', p: 12, gb: 7.1, tier: 'low' }],
  },
  {
    prefix: 'mistral-small',
    idPrefix: 'mistral-small',
    name: 'Mistral Small',
    purpose: 'general',
    // ollama.com/library/mistral-small
    sizes: [
      { s: '22b', idSize: '22b', p: 22, gb: 13, tier: 'medium' },
      { s: '24b', idSize: '24b', p: 24, gb: 14, tier: 'medium' },
    ],
  },
  {
    prefix: 'mistral-large',
    idPrefix: 'mistral-large',
    name: 'Mistral Large',
    purpose: 'general',
    // ollama.com/library/mistral-large
    sizes: [{ s: '123b', idSize: '123b', p: 123, gb: 73, tier: 'high' }],
  },
  {
    prefix: 'mixtral',
    idPrefix: 'mixtral',
    name: 'Mixtral',
    purpose: 'general',
    // ollama.com/library/mixtral — sparse MoE; `p` tracks total params.
    sizes: [
      { s: '8x7b', idSize: '8x7b', p: 47, gb: 26, tier: 'high' },
      { s: '8x22b', idSize: '8x22b', p: 141, gb: 80, tier: 'high' },
    ],
  },
  {
    prefix: 'llama3.2',
    idPrefix: 'llama3-2',
    name: 'Llama 3.2',
    purpose: 'general',
    // ollama.com/library/llama3.2
    sizes: [
      { s: '1b', idSize: '1b', p: 1, gb: 1.3, tier: 'cpu-only' },
      { s: '3b', idSize: '3b', p: 3, gb: 2.0, tier: 'cpu-only' },
    ],
  },
  {
    prefix: 'llama3.1',
    idPrefix: 'llama3-1',
    name: 'Llama 3.1',
    purpose: 'general',
    // ollama.com/library/llama3.1
    sizes: [
      { s: '8b', idSize: '8b', p: 8, gb: 4.9, tier: 'low' },
      { s: '70b', idSize: '70b', p: 70, gb: 43, tier: 'high' },
      { s: '405b', idSize: '405b', p: 405, gb: 243, tier: 'high' },
    ],
  },
  {
    prefix: 'llama3.3',
    idPrefix: 'llama3-3',
    name: 'Llama 3.3',
    purpose: 'general',
    // ollama.com/library/llama3.3
    sizes: [{ s: '70b', idSize: '70b', p: 70, gb: 43, tier: 'high' }],
  },
  {
    prefix: 'llama4',
    idPrefix: 'llama4',
    name: 'Llama 4',
    purpose: 'general',
    // ollama.com/library/llama4 — Scout (16x17B) and Maverick (128x17B) MoE; `p` tracks total params.
    sizes: [
      { s: '16x17b', idSize: '16x17b', p: 109, gb: 67, tier: 'high' },
      { s: '128x17b', idSize: '128x17b', p: 400, gb: 245, tier: 'high' },
    ],
  },
  {
    prefix: 'glm4',
    idPrefix: 'glm4',
    name: 'GLM-4',
    purpose: 'general',
    // ollama.com/library/glm4
    sizes: [{ s: '9b', idSize: '9b', p: 9, gb: 5.5, tier: 'low' }],
  },
  {
    prefix: 'gabegoodhart/minimax-m2',
    idPrefix: 'minimax-m2-community',
    name: 'MiniMax M2 (community)',
    purpose: 'general',
    // Community upload (no first-party local build): ollama.com/gabegoodhart/minimax-m2
    sizes: [{ s: '230b', idSize: '230b', p: 230, gb: 56, tier: 'high' }],
  },
];

// The default ollama pull (`model:size`) is the q4_K_M build; the catalog records that explicitly.
const DEFAULT_QUANT = 'q4_K_M';

const generatedLlms: CuratedModel[] = [];

for (const fam of FAMILIES) {
  for (const size of fam.sizes) {
    const diskMb = Math.round(size.gb * 1024);
    // Runtime RAM ≈ weights on disk plus KV-cache / runtime overhead. The tier budget fractions
    // (0.9 VRAM, 0.7 unified/RAM) provide the remaining headroom for the OS, app container, and context.
    const footprintMb = Math.round(diskMb * 1.1);
    generatedLlms.push({
      id: `${fam.idPrefix}-${size.idSize}`,
      backend: 'ollama',
      backendModelId: `${fam.prefix}:${size.s}`,
      modality: 'llm',
      purpose: fam.purpose,
      parameterScale: size.p,
      displayName: `${fam.name} ${size.s.toUpperCase()}`,
      description: `${fam.name} option for ${size.tier} tier systems.`,
      requirements: {
        minVramMb: diskMb,
        recommendedVramMb: Math.round(diskMb * 1.1 + 1024),
        minRamMb: Math.round(diskMb * 1.15),
        diskMb,
        gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'],
        npuRequired: false,
        minTier: size.tier,
      },
      runtime: {
        contextWindow: 131072,
        maxTokens: 8192,
        reasoning: fam.purpose === 'reasoning',
        input: ['text'],
        quantization: DEFAULT_QUANT,
        pinnedByDefault: size.p <= 4,
        memoryFootprintMb: footprintMb,
      },
      tiers: {
        high: size.tier === 'high' ? 'recommended' : 'available',
        medium: size.tier === 'medium' ? 'recommended' : size.tier === 'high' ? 'not-recommended' : 'available',
        low: size.tier === 'low' ? 'recommended' : size.tier === 'high' || size.tier === 'medium' ? 'not-recommended' : 'available',
        // CPU inference is viable for small/mid models. Mark cpu-only sizes 'recommended' and low-tier
        // sizes 'available' so the catalog's CPU-only browse set covers what the recommender can pick.
        cpuOnly: size.tier === 'cpu-only' ? 'recommended' : size.tier === 'low' ? 'available' : 'not-recommended',
      },
    });
  }
}

const VOICE_MODELS: CuratedModel[] = [
  {
    id: 'kokoro-v1',
    backend: 'lemonade',
    backendModelId: 'kokoro-v1',
    modality: 'tts',
    purpose: 'voice',
    displayName: 'Kokoro v1 TTS',
    description: 'High-quality text-to-speech. Low latency, natural sounding.',
    requirements: {
      minVramMb: 0,
      recommendedVramMb: 512,
      minRamMb: 1024,
      diskMb: 300,
      gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'],
      npuRequired: false,
      minTier: 'cpu-only',
    },
    runtime: {
      contextWindow: 0,
      maxTokens: 0,
      reasoning: false,
      input: ['text'],
      pinnedByDefault: true,
      memoryFootprintMb: 350,
    },
    tiers: { high: 'recommended', medium: 'recommended', low: 'recommended', cpuOnly: 'recommended' },
  },
  {
    id: 'whisper-large-v3-turbo',
    backend: 'lemonade',
    backendModelId: 'whisper-large-v3-turbo',
    modality: 'stt',
    purpose: 'transcription',
    displayName: 'Whisper Large v3 Turbo',
    description: "OpenAI's speech-to-text model. Fast and accurate transcription.",
    requirements: {
      minVramMb: 4096,
      recommendedVramMb: 6144,
      minRamMb: 8192,
      diskMb: 1500,
      gpuVendors: ['nvidia', 'amd', 'apple'],
      npuRequired: false,
      minTier: 'medium',
    },
    runtime: {
      contextWindow: 0,
      maxTokens: 0,
      reasoning: false,
      input: ['audio'],
      pinnedByDefault: false,
      memoryFootprintMb: 1500,
    },
    tiers: { high: 'recommended', medium: 'recommended', low: 'not-recommended', cpuOnly: 'not-recommended' },
  },
  {
    id: 'whisper-base',
    backend: 'lemonade',
    backendModelId: 'whisper-base',
    modality: 'stt',
    purpose: 'transcription',
    displayName: 'Whisper Base',
    description: 'Lightweight speech-to-text for resource-constrained environments.',
    requirements: {
      minVramMb: 0,
      recommendedVramMb: 512,
      minRamMb: 1024,
      diskMb: 150,
      gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'],
      npuRequired: false,
      minTier: 'cpu-only',
    },
    runtime: {
      contextWindow: 0,
      maxTokens: 0,
      reasoning: false,
      input: ['audio'],
      pinnedByDefault: false,
      memoryFootprintMb: 200,
    },
    tiers: { high: 'available', medium: 'available', low: 'recommended', cpuOnly: 'recommended' },
  },
];

const EMBEDDING_MODELS: CuratedModel[] = [
  {
    id: 'nomic-embed-text',
    backend: 'ollama',
    backendModelId: 'nomic-embed-text',
    modality: 'embedding',
    purpose: 'embedding',
    displayName: 'Nomic Embed Text',
    description: 'Local text-embedding model (768-dim). Default embeddings for CI memory / RAG (pgvector). Runs on any hardware.',
    requirements: {
      minVramMb: 0,
      recommendedVramMb: 512,
      minRamMb: 1024,
      diskMb: 300,
      gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'],
      npuRequired: false,
      minTier: 'cpu-only',
    },
    runtime: {
      contextWindow: 8192,
      maxTokens: 0,
      reasoning: false,
      input: ['text'],
      pinnedByDefault: true,
      memoryFootprintMb: 500,
    },
    tiers: { high: 'recommended', medium: 'recommended', low: 'recommended', cpuOnly: 'recommended' },
  },
  {
    id: 'embeddinggemma',
    backend: 'ollama',
    backendModelId: 'embeddinggemma',
    modality: 'embedding',
    purpose: 'embedding',
    displayName: 'EmbeddingGemma',
    description:
      "Google's 300M embedding model (768-dim, Matryoshka-truncatable to 512/256/128). Multilingual (100+ languages), 2K context. Drop-in pgvector replacement for Nomic at the same 768 dimensions, with stronger retrieval. Runs on any hardware.",
    requirements: {
      minVramMb: 0,
      recommendedVramMb: 1024,
      minRamMb: 1536,
      diskMb: 622,
      gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'],
      npuRequired: false,
      minTier: 'cpu-only',
    },
    runtime: {
      contextWindow: 2048,
      maxTokens: 0,
      reasoning: false,
      input: ['text'],
      pinnedByDefault: false,
      memoryFootprintMb: 700,
    },
    tiers: { high: 'available', medium: 'available', low: 'available', cpuOnly: 'available' },
  },
  {
    id: 'nomic-embed-text-v2-moe',
    backend: 'ollama',
    backendModelId: 'nomic-embed-text-v2-moe',
    modality: 'embedding',
    purpose: 'embedding',
    displayName: 'Nomic Embed Text v2 (MoE)',
    description:
      'Nomic Embed v2, a mixture-of-experts embedding model (~305M active / 475M total params, 768-dim). Multilingual (~100 languages) and pgvector-compatible with the 768-dim Nomic default. Runs on any hardware.',
    requirements: {
      minVramMb: 0,
      recommendedVramMb: 1024,
      minRamMb: 2048,
      diskMb: 900,
      gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'],
      npuRequired: false,
      minTier: 'cpu-only',
    },
    runtime: {
      contextWindow: 512,
      maxTokens: 0,
      reasoning: false,
      input: ['text'],
      pinnedByDefault: false,
      memoryFootprintMb: 900,
    },
    tiers: { high: 'available', medium: 'available', low: 'available', cpuOnly: 'available' },
  },
  {
    id: 'qwen3-embedding',
    backend: 'ollama',
    backendModelId: 'qwen3-embedding',
    modality: 'embedding',
    purpose: 'embedding',
    displayName: 'Qwen3 Embedding (0.6B)',
    description:
      'Qwen3 Embedding 0.6B (1024-dim, 32K context). Tops the multilingual MTEB leaderboard for its size across 100+ languages. Note: 1024-dim — switching from the 768-dim default requires re-embedding existing memories. Runs on any hardware.',
    requirements: {
      minVramMb: 0,
      recommendedVramMb: 1536,
      minRamMb: 2048,
      diskMb: 640,
      gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'],
      npuRequired: false,
      minTier: 'cpu-only',
    },
    runtime: {
      contextWindow: 32768,
      maxTokens: 0,
      reasoning: false,
      input: ['text'],
      pinnedByDefault: false,
      memoryFootprintMb: 800,
    },
    tiers: { high: 'available', medium: 'available', low: 'available', cpuOnly: 'available' },
  },
];

export const CURATED_MODELS: CuratedModel[] = [...generatedLlms, ...VOICE_MODELS, ...EMBEDDING_MODELS];
