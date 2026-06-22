import type { CuratedModel, HardwareTier, InferenceBackendType, ModelModality, ModelPurpose, TierRecommendation } from '@ci-hub/common/types';

// ─── LLM catalog (TOON) ──────────────────────────────────────────────────────
// The LLM catalog is authored as a TOON table (https://toonformat.dev) — one compact, pipe-delimited
// row per model. Every family + size is verified to exist on ollama.com/library (checked 2026-05) and
// the catalog lists only the bare `model:size` default tag (the guaranteed-pullable q4_K_M build).
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
//   agentic         Artificial Analysis agentic / tool-calling index (blank when not on the leaderboard)
//   reason          1 = reasoning model
//   vision          1 = accepts image input
//   tools           1 = supports tool / function calling
//   audio           1 = accepts audio/speech input
//   tps             AA median output tokens/sec (cloud reference; blank when unknown)
//   ttft            AA median latency to first chunk, seconds (cloud reference)
//   e2e             AA median end-to-end response time, seconds (cloud reference)
//
// `intel`, `tps`, `ttft`, `e2e` are Artificial Analysis open-weights leaderboard figures
// (artificialanalysis.ai, snapshot 2026-05); perf numbers are AA's cloud-hosted measurements and are
// indicative only — real local speed depends on the user's hardware and quantization.
const CATALOG_TOON = `
llms[59|]{id,backendModelId,name,purpose,params,gb,tier,ctxK,creator,intel,agentic,reason,vision,tools,audio,tps,ttft,e2e}:
  gemma4-e2b|gemma4:e2b|Gemma 4 E2B|general|2|7.2|cpu-only|128|Google|12.1|7.4|0|1|1|1|||
  gemma4-e4b|gemma4:e4b|Gemma 4 E4B|general|4|9.6|cpu-only|128|Google|14.8|8.7|0|1|1|1|||
  gemma4-26b|gemma4:26b|Gemma 4 26B|general|26|18|medium|256|Google|27.1|28.9|0|1|1|0|78|1.59|8
  gemma4-31b|gemma4:31b|Gemma 4 31B|general|31|20|medium|256|Google|32.3|39.4|0|1|1|0|17|1.38|30.7
  qwen3-6-27b|qwen3.6:27b|Qwen 3.6 27B|coding|27|17|medium|262|Alibaba|37.1|60.9|0|1|1|0|56|3.86|12.8
  qwen3-6-35b|qwen3.6:35b|Qwen 3.6 35B|coding|35|24|medium|262|Alibaba|31.5|52.5|0|1|1|0|179|2.56|5.4
  qwen3-5-0-8b|qwen3.5:0.8b|Qwen 3.5 0.8B|reasoning|0.8|1|cpu-only|262|Alibaba|9.9|21.7|1|1|1|0|74|0.45|7.2
  qwen3-5-2b|qwen3.5:2b|Qwen 3.5 2B|reasoning|2|2.7|cpu-only|262|Alibaba|14.7|27.2|1|1|1|0|247|0.42|2.4
  qwen3-5-4b|qwen3.5:4b|Qwen 3.5 4B|reasoning|4|3.4|cpu-only|262|Alibaba|22.6|36.3|1|1|1|0|198|0.45|3
  qwen3-5-9b|qwen3.5:9b|Qwen 3.5 9B|reasoning|9|6.6|low|262|Alibaba|27.3|41.1|1|1|1|0|||
  qwen3-5-27b|qwen3.5:27b|Qwen 3.5 27B|reasoning|27|17|medium||Alibaba|||1|0|1|0|||
  qwen3-5-35b|qwen3.5:35b|Qwen 3.5 35B|reasoning|35|24|medium|262|Alibaba|30.7|48|1|1|1|0|155|2.13|5.4
  qwen3-5-122b|qwen3.5:122b|Qwen 3.5 122B|reasoning|122|81|high|262|Alibaba|35.9|49.5|1|1|1|0|162|2.53|5.6
  nemotron3-33b|nemotron3:33b|Nemotron 3 33B|reasoning|33|28|medium||NVIDIA|||1|0|1|0|||
  nemotron-3-nano-4b|nemotron-3-nano:4b|Nemotron 3 Nano 4B|reasoning|4|2.8|cpu-only|262|NVIDIA|14.7|9.8|1|0|1|0|||
  nemotron-3-nano-30b|nemotron-3-nano:30b|Nemotron 3 Nano 30B|reasoning|30|24|medium|1000|NVIDIA|13.2|8.5|1|0|1|0|83|0.43|6.4
  nemotron-3-super-120b|nemotron-3-super:120b|Nemotron 3 Super 120B|reasoning|120|87|high|1000|NVIDIA|36|40.2|1|0|1|0|181|1.82|15.6
  gpt-oss-20b|gpt-oss:20b|GPT-OSS 20B|general|20|14|medium|131|OpenAI|24.5|27.6|1|0|1|0|239|0.74|11.2
  gpt-oss-120b|gpt-oss:120b|GPT-OSS 120B|general|120|65|high|131|OpenAI|33.3|37.9|1|0|1|0|322|0.86|8.6
  deepseek-r1-1-5b|deepseek-r1:1.5b|DeepSeek R1 1.5B|reasoning|1.5|1.1|cpu-only||DeepSeek|||1|0|1|0|||
  deepseek-r1-7b|deepseek-r1:7b|DeepSeek R1 7B|reasoning|7|4.7|low||DeepSeek|||1|0|1|0|||
  deepseek-r1-8b|deepseek-r1:8b|DeepSeek R1 8B|reasoning|8|5.2|low||DeepSeek|||1|0|1|0|||
  deepseek-r1-14b|deepseek-r1:14b|DeepSeek R1 14B|reasoning|14|9|low||DeepSeek|||1|0|1|0|||
  deepseek-r1-32b|deepseek-r1:32b|DeepSeek R1 32B|reasoning|32|20|medium||DeepSeek|||1|0|1|0|||
  deepseek-r1-70b|deepseek-r1:70b|DeepSeek R1 70B|reasoning|70|43|high||DeepSeek|||1|0|1|0|||
  deepseek-r1-671b|deepseek-r1:671b|DeepSeek R1 671B|reasoning|671|404|high||DeepSeek|||1|0|1|0|||
  deepseek-coder-v2-16b|deepseek-coder-v2:16b|DeepSeek Coder V2 16B|coding|16|8.9|medium||DeepSeek|||0|0|1|0|||
  deepseek-coder-v2-236b|deepseek-coder-v2:236b|DeepSeek Coder V2 236B|coding|236|133|high||DeepSeek|||0|0|1|0|||
  qwen3-0-6b|qwen3:0.6b|Qwen 3 0.6B|general|0.6|0.5|cpu-only||Alibaba|||0|0|1|0|||
  qwen3-1-7b|qwen3:1.7b|Qwen 3 1.7B|general|1.7|1.4|cpu-only||Alibaba|||0|0|1|0|||
  qwen3-4b|qwen3:4b|Qwen 3 4B|general|4|2.5|cpu-only||Alibaba|||0|0|1|0|||
  qwen3-8b|qwen3:8b|Qwen 3 8B|general|8|5.2|low||Alibaba|||0|0|1|0|||
  qwen3-14b|qwen3:14b|Qwen 3 14B|general|14|9.3|low||Alibaba|||0|0|1|0|||
  qwen3-30b|qwen3:30b|Qwen 3 30B|general|30|19|medium||Alibaba|||0|0|1|0|||
  qwen3-32b|qwen3:32b|Qwen 3 32B|general|32|20|medium||Alibaba|||0|0|1|0|||
  qwen3-235b|qwen3:235b|Qwen 3 235B|general|235|142|high||Alibaba|||0|0|1|0|||
  qwq-32b|qwq:32b|QwQ 32B|reasoning|32|20|medium||Alibaba|||1|0|1|0|||
  gemma3-270m|gemma3:270m|Gemma 3 270M|general|0.27|0.3|cpu-only|32|Google|7.7|3|0|0|1|0|||
  gemma3-1b|gemma3:1b|Gemma 3 1B|general|1|0.8|cpu-only||Google|||0|0|1|0|||
  gemma3-4b|gemma3:4b|Gemma 3 4B|general|4|3.3|cpu-only||Google|||0|0|1|0|||
  gemma3-12b|gemma3:12b|Gemma 3 12B|general|12|8.1|low||Google|||0|0|1|0|||
  gemma3-27b|gemma3:27b|Gemma 3 27B|general|27|17|medium||Google|||0|0|1|0|||
  mistral-7b|mistral:7b|Mistral 7B|general|7|4.4|low||Mistral|||0|0|1|0|||
  mistral-nemo-12b|mistral-nemo:12b|Mistral Nemo 12B|general|12|7.1|low||Mistral|||0|0|1|0|||
  mistral-small-22b|mistral-small:22b|Mistral Small 22B|general|22|13|medium||Mistral|||0|0|1|0|||
  mistral-small-24b|mistral-small:24b|Mistral Small 24B|general|24|14|medium||Mistral|||0|0|1|0|||
  mistral-large-123b|mistral-large:123b|Mistral Large 123B|general|123|73|high||Mistral|||0|0|1|0|||
  mixtral-8x7b|mixtral:8x7b|Mixtral 8X7B|general|47|26|high||Mistral|||0|0|1|0|||
  mixtral-8x22b|mixtral:8x22b|Mixtral 8X22B|general|141|80|high||Mistral|||0|0|1|0|||
  llama3-2-1b|llama3.2:1b|Llama 3.2 1B|general|1|1.3|cpu-only||Meta|||0|0|1|0|||
  llama3-2-3b|llama3.2:3b|Llama 3.2 3B|general|3|2|cpu-only||Meta|||0|0|1|0|||
  llama3-1-8b|llama3.1:8b|Llama 3.1 8B|general|8|4.9|low||Meta|||0|0|1|0|||
  llama3-1-70b|llama3.1:70b|Llama 3.1 70B|general|70|43|high||Meta|||0|0|1|0|||
  llama3-1-405b|llama3.1:405b|Llama 3.1 405B|general|405|243|high|128|Meta|17.4|6.3|0|0|1|0|40|2.35|15
  llama3-3-70b|llama3.3:70b|Llama 3.3 70B|general|70|43|high|128|Meta|14.5|9.1|0|0|1|0|80|1.61|7.8
  llama4-16x17b|llama4:16x17b|Llama 4 16X17B|general|109|67|high|10000|Meta|13.5|5.2|0|1|1|0|105|0.85|5.6
  llama4-128x17b|llama4:128x17b|Llama 4 128X17B|general|400|245|high|1000|Meta|18.4|7.2|0|1|1|0|111|0.98|5.5
  glm4-9b|glm4:9b|GLM-4 9B|general|9|5.5|low||Z AI|||0|0|1|0|||
  minimax-m2-community-230b|gabegoodhart/minimax-m2:230b|MiniMax M2 230B|general|230|56|high|205|MiniMax|36.1|47.5|1|0|1|0|||
`;

/** A decoded TOON row: every column mapped to its raw string cell (empty string when blank). */
type ToonRow = Record<string, string>;

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
  'minimax-m2-community-230b': 10, // MiniMax M2 (MoE)
};

const generatedLlms: CuratedModel[] = decodeToonTable(CATALOG_TOON, 'llms').map((row): CuratedModel => {
  const params = Number(row.params);
  const gb = Number(row.gb);
  const tier = (row.tier ?? 'cpu-only') as HardwareTier;
  const diskMb = Math.round(gb * 1024);
  // Runtime RAM ≈ weights on disk plus KV-cache / runtime overhead. The tier budget fractions
  // (0.9 VRAM, 0.7 unified/RAM) provide the remaining headroom for the OS, app container, and context.
  const footprintMb = Math.round(diskMb * 1.1);
  const reasoning = flag(row.reason);
  const vision = flag(row.vision);
  const audio = flag(row.audio);
  const tools = flag(row.tools);
  const contextWindowK = numOrUndef(row.ctxK);
  const intelligenceIndex = numOrUndef(row.intel);
  const toolCallingIndex = numOrUndef(row.agentic);
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
    backend: 'ollama',
    backendModelId: row.backendModelId ?? '',
    modality: 'llm',
    purpose: (row.purpose ?? 'general') as ModelPurpose,
    displayName: row.name ?? '',
    description: `${row.name} — ${row.creator || 'open'} model for ${tier} tier systems.`,
    parameterScale: params,
    activeParameterScale: MOE_ACTIVE_PARAMS_B[row.id ?? ''] ?? params,
    requirements: {
      minVramMb: diskMb,
      recommendedVramMb: Math.round(diskMb * 1.1 + 1024),
      minRamMb: Math.round(diskMb * 1.15),
      diskMb,
      gpuVendors: ['nvidia', 'amd', 'apple', 'cpu'],
      npuRequired: false,
      minTier: tier,
    },
    runtime: {
      contextWindow: contextWindowK ? contextWindowK * 1000 : 131072,
      maxTokens: 8192,
      reasoning,
      input,
      quantization: 'q4_K_M',
      pinnedByDefault: params <= 4,
      memoryFootprintMb: footprintMb,
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
      ...(toolCallingIndex === undefined ? {} : { toolCallingIndex }),
      capabilities: { reasoning, vision, tools, audio },
      ...(perf ? { perf } : {}),
    },
  };
});

// Non-LLM models (voice + embedding) in TOON. Unlike the LLM table these carry explicit requirements
// (they aren't derived from a parameter count); purpose and input modality are derived from `modality`.
// Voice models run on the Lemonade backend; embedders on Ollama. cpu=1 means CPU inference is supported.
const EXTRAS_TOON = `
extras[7|]{id,backendModelId,backend,modality,name,creator,diskMb,footprintMb,minRamMb,recVramMb,minVramMb,ctx,minTier,cpu,pinned,tierHigh,tierMed,tierLow,tierCpu,desc}:
  kokoro-v1|kokoro-v1|lemonade|tts|Kokoro v1 TTS|Hexgrad|300|350|1024|512|0|0|cpu-only|1|1|recommended|recommended|recommended|recommended|High-quality text-to-speech. Low latency, natural sounding.
  whisper-large-v3-turbo|whisper-large-v3-turbo|lemonade|stt|Whisper Large v3 Turbo|OpenAI|1500|1500|8192|6144|4096|0|medium|0|0|recommended|recommended|not-recommended|not-recommended|OpenAI's speech-to-text model. Fast and accurate transcription.
  whisper-base|whisper-base|lemonade|stt|Whisper Base|OpenAI|150|200|1024|512|0|0|cpu-only|1|0|available|available|recommended|recommended|Lightweight speech-to-text for resource-constrained environments.
  nomic-embed-text|nomic-embed-text|ollama|embedding|Nomic Embed Text|Nomic|300|500|1024|512|0|8192|cpu-only|1|1|recommended|recommended|recommended|recommended|Local text-embedding model (768-dim). Default embeddings for CI memory / RAG (pgvector). Runs on any hardware.
  embeddinggemma|embeddinggemma|ollama|embedding|EmbeddingGemma|Google|622|700|1536|1024|0|2048|cpu-only|1|0|available|available|available|available|Google's 300M embedding model (768-dim, Matryoshka-truncatable to 512/256/128). Multilingual (100+ languages), 2K context. Drop-in pgvector replacement for Nomic at the same 768 dimensions, with stronger retrieval. Runs on any hardware.
  nomic-embed-text-v2-moe|nomic-embed-text-v2-moe|ollama|embedding|Nomic Embed Text v2 (MoE)|Nomic|900|900|2048|1024|0|512|cpu-only|1|0|available|available|available|available|Nomic Embed v2, a mixture-of-experts embedding model (~305M active / 475M total params, 768-dim). Multilingual (~100 languages) and pgvector-compatible with the 768-dim Nomic default. Runs on any hardware.
  qwen3-embedding|qwen3-embedding|ollama|embedding|Qwen3 Embedding (0.6B)|Alibaba|640|800|2048|1536|0|32768|cpu-only|1|0|available|available|available|available|Qwen3 Embedding 0.6B (1024-dim, 32K context). Tops the multilingual MTEB leaderboard for its size across 100+ languages. Note: 1024-dim — switching from the 768-dim default requires re-embedding existing memories. Runs on any hardware.
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

export const CURATED_MODELS: CuratedModel[] = [...generatedLlms, ...extraModels];
