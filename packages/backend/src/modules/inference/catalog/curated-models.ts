import type { CuratedModel, HardwareTier, ModelPurpose } from '@ci-hub/common/types';

const QUANTS = [
  { suffix: 'fp16', name: 'FP16', mult: 3.2 },
  { suffix: 'q8_0', name: '8-bit', mult: 1.7 },
  { suffix: 'q6_K', name: '6-bit', mult: 1.3 },
  { suffix: 'q5_K_M', name: '5-bit', mult: 1.15 },
  { suffix: 'q4_K_M', name: '4-bit', mult: 1.0 },
  { suffix: 'q3_K_M', name: '3-bit', mult: 0.75 },
];

const FAMILIES = [
  {
    prefix: 'gemma4',
    idPrefix: 'gemma4',
    name: 'Gemma 4',
    purpose: 'general' as ModelPurpose,
    // Parameter variants per ollama.com/library/gemma4: E2B/E4B (effective-param edge builds),
    // 26B (MoE, 4B active), 31B (dense). Larger sizes below are forward-looking catalog entries.
    sizes: [
      { s: 'e2b', idSize: 'e2b', p: 2, tier: 'cpu-only' as HardwareTier },
      { s: 'e4b', idSize: 'e4b', p: 4, tier: 'cpu-only' as HardwareTier },
      { s: '4b', idSize: '4b', p: 4, tier: 'cpu-only' as HardwareTier },
      { s: '12b', idSize: '12b', p: 12, tier: 'low' as HardwareTier },
      { s: '26b', idSize: '26b', p: 26, tier: 'medium' as HardwareTier },
      { s: '27b', idSize: '27b', p: 27, tier: 'medium' as HardwareTier },
      { s: '31b', idSize: '31b', p: 31, tier: 'medium' as HardwareTier },
      { s: '70b', idSize: '70b', p: 70, tier: 'high' as HardwareTier },
      { s: '300b', idSize: '300b', p: 300, tier: 'high' as HardwareTier },
      { s: '800b', idSize: '800b', p: 800, tier: 'high' as HardwareTier },
      { s: '3t', idSize: '3t', p: 3000, tier: 'high' as HardwareTier },
    ],
  },
  {
    prefix: 'qwen3.6',
    idPrefix: 'qwen3-6',
    name: 'Qwen 3.6',
    purpose: 'coding' as ModelPurpose,
    // 27B/35B ship on ollama.com/library/qwen3.6; other sizes are forward-looking catalog entries.
    sizes: [
      { s: '8b', idSize: '8b', p: 8, tier: 'low' as HardwareTier },
      { s: '20b', idSize: '20b', p: 20, tier: 'medium' as HardwareTier },
      { s: '27b', idSize: '27b', p: 27, tier: 'medium' as HardwareTier },
      { s: '35b', idSize: '35b', p: 35, tier: 'medium' as HardwareTier },
      { s: '72b', idSize: '72b', p: 72, tier: 'high' as HardwareTier },
      { s: '200b', idSize: '200b', p: 200, tier: 'high' as HardwareTier },
      { s: '500b', idSize: '500b', p: 500, tier: 'high' as HardwareTier },
      { s: '1.5t', idSize: '1-5t', p: 1500, tier: 'high' as HardwareTier },
    ],
  },
  {
    prefix: 'qwen3.5',
    idPrefix: 'qwen3-5',
    name: 'Qwen 3.5',
    purpose: 'reasoning' as ModelPurpose,
    // Parameter variants per ollama.com/library/qwen3.5 (0.8B → 122B locally; 397B-A17B cloud/MoE).
    sizes: [
      { s: '0.8b', idSize: '0-8b', p: 0.8, tier: 'cpu-only' as HardwareTier },
      { s: '2b', idSize: '2b', p: 2, tier: 'cpu-only' as HardwareTier },
      { s: '4b', idSize: '4b', p: 4, tier: 'cpu-only' as HardwareTier },
      { s: '9b', idSize: '9b', p: 9, tier: 'low' as HardwareTier },
      { s: '27b', idSize: '27b', p: 27, tier: 'medium' as HardwareTier },
      { s: '35b', idSize: '35b', p: 35, tier: 'medium' as HardwareTier },
      { s: '122b', idSize: '122b', p: 122, tier: 'high' as HardwareTier },
      { s: '397b-a17b', idSize: '397b-a17b', p: 397, tier: 'high' as HardwareTier },
    ],
  },
  {
    prefix: 'nemotron3',
    idPrefix: 'nemotron3',
    name: 'Nemotron 3',
    purpose: 'reasoning' as ModelPurpose,
    // 33B is the shipped ollama.com/library/nemotron3 size (nano 4B/30B and super 120B are
    // separate Ollama slugs); other sizes are forward-looking catalog entries.
    sizes: [
      { s: '8b', idSize: '8b', p: 8, tier: 'low' as HardwareTier },
      { s: '22b', idSize: '22b', p: 22, tier: 'medium' as HardwareTier },
      { s: '33b', idSize: '33b', p: 33, tier: 'medium' as HardwareTier },
      { s: '70b', idSize: '70b', p: 70, tier: 'high' as HardwareTier },
      { s: 'super-120b-a12b', idSize: 'super-120b-a12b', p: 120, tier: 'high' as HardwareTier },
      { s: '340b', idSize: '340b', p: 340, tier: 'high' as HardwareTier },
      { s: '1t', idSize: '1t', p: 1000, tier: 'high' as HardwareTier },
    ],
  },
  {
    prefix: 'hermes4',
    idPrefix: 'hermes4',
    name: 'Hermes 4',
    purpose: 'general' as ModelPurpose,
    sizes: [
      { s: '4b', idSize: '4b', p: 4, tier: 'cpu-only' as HardwareTier },
      { s: '8b', idSize: '8b', p: 8, tier: 'low' as HardwareTier },
      { s: '70b', idSize: '70b', p: 70, tier: 'high' as HardwareTier },
      { s: '405b', idSize: '405b', p: 405, tier: 'high' as HardwareTier },
      { s: '1t', idSize: '1t', p: 1000, tier: 'high' as HardwareTier },
    ],
  },
  {
    prefix: 'deepseek',
    idPrefix: 'deepseek',
    name: 'DeepSeek',
    purpose: 'reasoning' as ModelPurpose,
    sizes: [
      { s: 'v4-flash', idSize: 'v4-flash', p: 100, tier: 'high' as HardwareTier },
      { s: 'r10528', idSize: 'r10528', p: 200, tier: 'high' as HardwareTier },
      { s: 'v4-pro', idSize: 'v4-pro', p: 500, tier: 'high' as HardwareTier },
    ],
  },
  {
    prefix: 'mistral',
    idPrefix: 'mistral',
    name: 'Mistral',
    purpose: 'general' as ModelPurpose,
    sizes: [
      { s: 'small-3.2', idSize: 'small-3.2', p: 24, tier: 'medium' as HardwareTier },
      { s: 'medium-3.5', idSize: 'medium-3.5', p: 100, tier: 'high' as HardwareTier },
    ],
  },
  {
    prefix: 'kimi',
    idPrefix: 'kimi',
    name: 'Kimi',
    purpose: 'general' as ModelPurpose,
    sizes: [
      { s: 'k2.6', idSize: 'k2-6', p: 100, tier: 'high' as HardwareTier },
      { s: 'k2-think-v2', idSize: 'k2-think-v2', p: 60, tier: 'high' as HardwareTier },
    ],
  },
  {
    prefix: 'mimo',
    idPrefix: 'mimo',
    name: 'MiMo',
    purpose: 'general' as ModelPurpose,
    sizes: [{ s: 'v2.5-pro', idSize: 'v2-5-pro', p: 140, tier: 'high' as HardwareTier }],
  },
  {
    prefix: 'glm',
    idPrefix: 'glm',
    name: 'GLM',
    purpose: 'reasoning' as ModelPurpose,
    sizes: [{ s: '5.1', idSize: '5-1', p: 130, tier: 'high' as HardwareTier }],
  },
  {
    prefix: 'minimax',
    idPrefix: 'minimax',
    name: 'MiniMax',
    purpose: 'general' as ModelPurpose,
    sizes: [{ s: 'm2.7', idSize: 'm2-7', p: 100, tier: 'high' as HardwareTier }],
  },
  {
    prefix: 'gpt-oss',
    idPrefix: 'gpt-oss',
    name: 'GPT-OSS',
    purpose: 'general' as ModelPurpose,
    sizes: [
      { s: '20b', idSize: '20b', p: 20, tier: 'medium' as HardwareTier },
      { s: '120b', idSize: '120b', p: 120, tier: 'high' as HardwareTier },
    ],
  },
  {
    prefix: 'qwq',
    idPrefix: 'qwq',
    name: 'QwQ',
    purpose: 'reasoning' as ModelPurpose,
    sizes: [{ s: '32b', idSize: '32b', p: 32, tier: 'medium' as HardwareTier }],
  },
  {
    // DeepSeek R1 is the family member with a real local parameter ladder on Ollama.
    // ollama.com/library/deepseek-r1 (v4-pro/v4-flash above are cloud-only).
    prefix: 'deepseek-r1',
    idPrefix: 'deepseek-r1',
    name: 'DeepSeek R1',
    purpose: 'reasoning' as ModelPurpose,
    sizes: [
      { s: '1.5b', idSize: '1-5b', p: 1.5, tier: 'cpu-only' as HardwareTier },
      { s: '7b', idSize: '7b', p: 7, tier: 'low' as HardwareTier },
      { s: '8b', idSize: '8b', p: 8, tier: 'low' as HardwareTier },
      { s: '14b', idSize: '14b', p: 14, tier: 'low' as HardwareTier },
      { s: '32b', idSize: '32b', p: 32, tier: 'medium' as HardwareTier },
      { s: '70b', idSize: '70b', p: 70, tier: 'high' as HardwareTier },
      { s: '671b', idSize: '671b', p: 671, tier: 'high' as HardwareTier },
    ],
  },
  {
    // ollama.com/library/glm4 (glm-5/glm-5.1 are cloud-only).
    prefix: 'glm4',
    idPrefix: 'glm4',
    name: 'GLM-4',
    purpose: 'general' as ModelPurpose,
    sizes: [{ s: '9b', idSize: '9b', p: 9, tier: 'low' as HardwareTier }],
  },
  {
    // ollama.com/library/nemotron-3-nano
    prefix: 'nemotron-3-nano',
    idPrefix: 'nemotron-3-nano',
    name: 'Nemotron 3 Nano',
    purpose: 'reasoning' as ModelPurpose,
    sizes: [
      { s: '4b', idSize: '4b', p: 4, tier: 'cpu-only' as HardwareTier },
      { s: '30b', idSize: '30b', p: 30, tier: 'medium' as HardwareTier },
    ],
  },
  {
    // ollama.com/library/nemotron-3-super — 120B MoE, ~12B active.
    prefix: 'nemotron-3-super',
    idPrefix: 'nemotron-3-super',
    name: 'Nemotron 3 Super',
    purpose: 'reasoning' as ModelPurpose,
    sizes: [{ s: '120b', idSize: '120b', p: 120, tier: 'high' as HardwareTier }],
  },
];

const BASE_LLMS: Array<
  Omit<CuratedModel, 'id' | 'backendModelId' | 'displayName' | 'backend'> & {
    baseId: string;
    baseBackendModelId: string;
    baseDisplayName: string;
  }
> = [];

for (const fam of FAMILIES) {
  for (const size of fam.sizes) {
    BASE_LLMS.push({
      baseId: `${fam.idPrefix}-${size.idSize}`,
      baseBackendModelId: `${fam.prefix}:${size.s}`,
      modality: 'llm',
      purpose: fam.purpose,
      parameterScale: size.p,
      baseDisplayName: `${fam.name} ${size.s.toUpperCase()}`,
      description: `${fam.name} option for ${size.tier} tier systems.`,
      requirements: {
        minVramMb: Math.round(size.p * 600),
        recommendedVramMb: Math.round(size.p * 650 + 2000),
        minRamMb: Math.round(size.p * 1800),
        diskMb: Math.round(size.p * 680),
        gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'],
        npuRequired: false,
        minTier: size.tier,
      },
      runtime: {
        contextWindow: 131072,
        maxTokens: 8192,
        reasoning: fam.purpose === 'reasoning',
        input: ['text'],
        pinnedByDefault: size.p <= 4,
        memoryFootprintMb: Math.round(size.p * 650 + 1500),
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

const generatedLlms: CuratedModel[] = [];

for (const base of BASE_LLMS) {
  for (const q of QUANTS) {
    const isQ4 = q.suffix === 'q4_K_M';
    generatedLlms.push({
      id: isQ4 ? base.baseId : `${base.baseId}-${q.suffix}`,
      backend: 'ollama',
      backendModelId: isQ4 ? base.baseBackendModelId : `${base.baseBackendModelId}-${q.suffix}`,
      modality: base.modality,
      purpose: base.purpose,
      parameterScale: base.parameterScale,
      displayName: isQ4 ? base.baseDisplayName : `${base.baseDisplayName} (${q.name})`,
      description: base.description,
      requirements: {
        ...base.requirements,
        minVramMb: Math.round(base.requirements.minVramMb * q.mult),
        recommendedVramMb: Math.round(base.requirements.recommendedVramMb * q.mult),
        minRamMb: Math.round(base.requirements.minRamMb * q.mult),
        diskMb: Math.round(base.requirements.diskMb * q.mult),
      },
      runtime: {
        ...base.runtime,
        quantization: q.suffix,
        pinnedByDefault: isQ4 ? base.runtime.pinnedByDefault : false,
        memoryFootprintMb: Math.round(base.runtime.memoryFootprintMb * q.mult),
      },
      tiers: base.tiers,
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

export const CURATED_MODELS: CuratedModel[] = [...generatedLlms, ...VOICE_MODELS];
