import type { CuratedModel, HardwareTier, InferenceBackendType, ModelModality, ModelPurpose, TierRecommendation } from '@ci-hub/common/types';

// ─── LLM catalog (TOON) ──────────────────────────────────────────────────────
// The LLM catalog is authored as a TOON table (https://toonformat.dev) — one compact, pipe-delimited
// row per model. Every family + size is verified to exist on ollama.com/library (checked 2026-05, rows
// from `laguna-xs-2-1` through `medgemma1-5-thinking` added 2026-07-27, whole table re-audited and
// corrected 2026-07-27 — see PR description for the full audit writeup and its caveats) and the catalog
// lists only the bare `model:size` default tag (the guaranteed-pullable q4_K_M build), with documented
// exceptions: rows whose backendModelId carries a `namespace/model:tag` shape (e.g.
// `gabegoodhart/minimax-m2`, `bjoernb/gemma4-26b-think`, `jordimurgo/medgemma1.5-thinking`) pull a
// community quant/fine-tune from an individual publisher rather than the official library — quality and
// provenance are that publisher's, not vetted the way official-library rows are; and rows like `inkling`
// and `glm-5-2`, which have no (or no longer any) ollama.com/library listing, pull the GGUF repack
// directly from Hugging Face via Ollama's `hf.co/{repo}:{quant}` pull syntax
// (`ollama pull hf.co/unsloth/inkling-GGUF:UD-Q4_K_XL`).
//
// LOCAL ONLY: this catalog must never contain an ollama `:cloud`-tagged backendModelId. Those proxy
// inference through Ollama Cloud's own API rather than running on the user's hardware, which breaks the
// hardware-fit recommender (a cloud row's nominal "size" trivially "fits" any budget, so it can silently
// win every "best local model for this box" comparison — see `isCloudProxyModel` in
// model-registry.service.ts, added after this exact bug surfaced during the 2026-07-27 audit below). If a
// model is only available as `:cloud` on Ollama, either find a real local GGUF (as `glm-5-2` does, via
// `hf.co/unsloth/GLM-5.2-GGUF`) or leave it out of the catalog rather than adding the cloud tag.
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
// `intel`, `tps`, `ttft`, `e2e` are Artificial Analysis open-weights leaderboard figures (artificialanalysis.ai;
// most re-verified 2026-07-27, a few pre-2026-05 rows left as unconfirmed where independent re-fetches gave
// conflicting numbers — see PR description); perf numbers are AA's cloud-hosted measurements and are
// indicative only — real local speed depends on the user's hardware and quantization. Note: AA's Intelligence
// Index scores dropped noticeably across almost every re-checked model between the 2026-05 and 2026-07-27
// passes (e.g. gpt-oss-120b 33.3→24, llama-3.3-70b 14.5→9) — consistent with AA having rebased/recalibrated
// the index in between, not with the older numbers being wrong at the time they were entered.
const CATALOG_TOON = `
llms[69|]{id,backendModelId,name,purpose,params,gb,tier,ctxK,creator,intel,agentic,reason,vision,tools,audio,tps,ttft,e2e}:
  gemma4-e2b|gemma4:e2b|Gemma 4 E2B|general|2|7.2|cpu-only|128|Google|9|7.4|1|1|1|1|||
  gemma4-e4b|gemma4:e4b|Gemma 4 E4B|general|4|9.6|cpu-only|128|Google|12|8.7|1|1|1|1|||
  gemma4-26b|gemma4:26b|Gemma 4 26B|general|26|18|medium|256|Google|26|28.9|1|1|1|0|78|1.59|8
  gemma4-31b|gemma4:31b|Gemma 4 31B|general|31|20|medium|256|Google|29|39.4|1|1|1|0|17|1.38|30.7
  qwen3-6-27b|qwen3.6:27b|Qwen 3.6 27B|coding|27|17|medium|262|Alibaba|37.1|60.9|1|1|1|0|56|3.66|12.8
  qwen3-6-35b|qwen3.6:35b|Qwen 3.6 35B|coding|35|24|medium|262|Alibaba|31.5|52.5|1|1|1|0|158.2|2.22|5.4
  qwen3-5-0-8b|qwen3.5:0.8b|Qwen 3.5 0.8B|reasoning|0.8|1|cpu-only|262|Alibaba|9.9|21.7|1|1|1|0|74|0.45|7.2
  qwen3-5-2b|qwen3.5:2b|Qwen 3.5 2B|reasoning|2|2.7|cpu-only|262|Alibaba|14.7|27.2|1|1|1|0|247|0.42|2.4
  qwen3-5-4b|qwen3.5:4b|Qwen 3.5 4B|reasoning|4|3.4|cpu-only|262|Alibaba|20|36.3|1|1|1|0|198|0.76|3
  qwen3-5-9b|qwen3.5:9b|Qwen 3.5 9B|reasoning|9|6.6|low|262|Alibaba|21|41.1|1|1|1|0|74|1.57|
  qwen3-5-27b|qwen3.5:27b|Qwen 3.5 27B|reasoning|27|17|medium|262|Alibaba|34||1|1|1|0|||
  qwen3-5-35b|qwen3.5:35b|Qwen 3.5 35B|reasoning|35|24|medium|262|Alibaba|29|48|1|1|1|0|117.8|2.13|5.4
  qwen3-5-122b|qwen3.5:122b|Qwen 3.5 122B|reasoning|122|81|high|262|Alibaba|32|49.5|1|1|1|0|133.2|2.32|5.6
  nemotron3-33b|nemotron3:33b|Nemotron 3 33B|reasoning|33|28|medium||NVIDIA|||1|1|1|1|||
  nemotron-3-nano-4b|nemotron-3-nano:4b|Nemotron 3 Nano 4B|reasoning|4|2.8|cpu-only|262|NVIDIA|9|9.8|1|0|1|0|||
  nemotron-3-nano-30b|nemotron-3-nano:30b|Nemotron 3 Nano 30B|reasoning|30|24|medium|1000|NVIDIA|14|8.5|1|0|1|0|167.3|1.44|6.4
  nemotron-3-super-120b|nemotron-3-super:120b|Nemotron 3 Super 120B|reasoning|120|87|high|256|NVIDIA|25|40.2|1|0|1|0|181|1.65|15.6
  gpt-oss-20b|gpt-oss:20b|GPT-OSS 20B|general|20|14|medium|131|OpenAI|15|27.6|1|0|1|0|194.2|0.82|11.2
  gpt-oss-120b|gpt-oss:120b|GPT-OSS 120B|general|120|65|high|131|OpenAI|24|37.9|1|0|1|0|285.7|0.86|8.6
  deepseek-r1-1-5b|deepseek-r1:1.5b|DeepSeek R1 1.5B|reasoning|1.5|1.1|cpu-only||DeepSeek|4||1|0|1|0|||
  deepseek-r1-7b|deepseek-r1:7b|DeepSeek R1 7B|reasoning|7|4.7|low||DeepSeek|||1|0|1|0|||
  deepseek-r1-8b|deepseek-r1:8b|DeepSeek R1 8B|reasoning|8|5.2|low||DeepSeek|10||1|0|1|0|||
  deepseek-r1-14b|deepseek-r1:14b|DeepSeek R1 14B|reasoning|14|9|low||DeepSeek|10||1|0|1|0|||
  deepseek-r1-32b|deepseek-r1:32b|DeepSeek R1 32B|reasoning|32|20|medium||DeepSeek|11||1|0|1|0|||
  deepseek-r1-70b|deepseek-r1:70b|DeepSeek R1 70B|reasoning|70|43|high||DeepSeek|10||1|0|1|0|||
  deepseek-r1-671b|deepseek-r1:671b|DeepSeek R1 671B|reasoning|671|404|high|160|DeepSeek|20||1|0|1|0|||
  deepseek-coder-v2-16b|deepseek-coder-v2:16b|DeepSeek Coder V2 16B|coding|16|8.9|medium|160|DeepSeek|||0|0|0|0|||
  deepseek-coder-v2-236b|deepseek-coder-v2:236b|DeepSeek Coder V2 236B|coding|236|133|high|4|DeepSeek|||0|0|0|0|||
  qwen3-0-6b|qwen3:0.6b|Qwen 3 0.6B|general|0.6|0.5|cpu-only|40|Alibaba|||1|0|1|0|||
  qwen3-1-7b|qwen3:1.7b|Qwen 3 1.7B|general|1.7|1.4|cpu-only|40|Alibaba|||1|0|1|0|||
  qwen3-4b|qwen3:4b|Qwen 3 4B|general|4|2.5|cpu-only|256|Alibaba|||1|0|1|0|||
  qwen3-8b|qwen3:8b|Qwen 3 8B|general|8|5.2|low|40|Alibaba|||1|0|1|0|||
  qwen3-14b|qwen3:14b|Qwen 3 14B|general|14|9.3|low|40|Alibaba|||1|0|1|0|||
  qwen3-30b|qwen3:30b|Qwen 3 30B|general|30|19|medium|256|Alibaba|||1|0|1|0|||
  qwen3-32b|qwen3:32b|Qwen 3 32B|general|32|20|medium|40|Alibaba|||1|0|1|0|||
  qwen3-235b|qwen3:235b|Qwen 3 235B|general|235|142|high|256|Alibaba|||1|0|1|0|||
  qwq-32b|qwq:32b|QwQ 32B|reasoning|32|20|medium|40|Alibaba|13.4||1|0|1|0|||
  gemma3-270m|gemma3:270m|Gemma 3 270M|general|0.27|0.3|cpu-only|32|Google|2.4||0|0|0|0|||
  gemma3-1b|gemma3:1b|Gemma 3 1B|general|1|0.8|cpu-only|32|Google|1||0|0|0|0|||
  gemma3-4b|gemma3:4b|Gemma 3 4B|general|4|3.3|cpu-only||Google|1.1||0|1|0|0|||
  gemma3-12b|gemma3:12b|Gemma 3 12B|general|12|8.1|low||Google|||0|1|0|0|||
  gemma3-27b|gemma3:27b|Gemma 3 27B|general|27|17|medium||Google|||0|1|0|0|||
  mistral-7b|mistral:7b|Mistral 7B|general|7|4.4|low|32|Mistral|||0|0|1|0|||
  mistral-nemo-12b|mistral-nemo:12b|Mistral Nemo 12B|general|12|7.1|low||Mistral|||0|0|1|0|||
  mistral-small-22b|mistral-small:22b|Mistral Small 22B|general|22|13|medium||Mistral|||0|0|1|0|||
  mistral-small-24b|mistral-small:24b|Mistral Small 24B|general|24|14|medium|32|Mistral|||0|0|1|0|||
  mistral-large-123b|mistral-large:123b|Mistral Large 123B|general|123|73|high||Mistral|||0|0|1|0|||
  mixtral-8x7b|mixtral:8x7b|Mixtral 8X7B|general|47|26|high|32|Mistral|||0|0|1|0|||
  mixtral-8x22b|mixtral:8x22b|Mixtral 8X22B|general|141|80|high|64|Mistral|||0|0|1|0|||
  llama3-2-1b|llama3.2:1b|Llama 3.2 1B|general|1|1.3|cpu-only||Meta|||0|0|1|0|||
  llama3-2-3b|llama3.2:3b|Llama 3.2 3B|general|3|2|cpu-only||Meta|||0|0|1|0|||
  llama3-1-8b|llama3.1:8b|Llama 3.1 8B|general|8|4.9|low||Meta|||0|0|1|0|||
  llama3-1-70b|llama3.1:70b|Llama 3.1 70B|general|70|43|high||Meta|||0|0|1|0|||
  llama3-1-405b|llama3.1:405b|Llama 3.1 405B|general|405|243|high|128|Meta|9||0|0|1|0|||
  llama3-3-70b|llama3.3:70b|Llama 3.3 70B|general|70|43|high|128|Meta|9||0|0|1|0|85.1|1.65|7.8
  llama4-16x17b|llama4:16x17b|Llama 4 16X17B|general|109|67|high|10000|Meta|10||0|1|1|0|95.9|0.76|5.6
  llama4-128x17b|llama4:128x17b|Llama 4 128X17B|general|400|245|high|1000|Meta|14||0|1|1|0|105.3|0.92|5.5
  glm4-9b|glm4:9b|GLM-4 9B|general|9|5.5|low||Z AI|||0|0|1|0|||
  minimax-m2-community-230b|gabegoodhart/minimax-m2:230b|MiniMax M2 230B|general|230|56|high|205|MiniMax|28||1|0|1|0|||
  glm-5-2|hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL|GLM 5.2|reasoning|754|467|high|1000|Z AI|51||1|0|1|0|||
  laguna-xs-2-1|laguna-xs-2.1:latest|Laguna XS 2.1|coding|33|20|medium|256|Poolside|||1|0|1|0|||
  laguna-s-2-1|laguna-s-2.1:latest|Laguna S 2.1|coding|118|75|high|256|Poolside|||1|0|1|0|||
  ornith-9b|ornith:9b|Ornith 9B|coding|9|5.6|low|256|Deep Reinforce|||1|0|1|0|||
  ornith-35b|ornith:35b|Ornith 35B|coding|35|21|medium|256|Deep Reinforce|||1|0|1|0|||
  lfm2-5-8b|lfm2.5:8b|LFM 2.5 8B|general|8|5.2|cpu-only|125|Liquid AI|8||0|0|1|0|||
  north-mini-code-1-0|north-mini-code-1.0:latest|North Mini Code 1.0|coding|30|19|medium|488|Cohere|27.6|21.7|1|0|1|0|||
  inkling|hf.co/unsloth/inkling-GGUF:UD-Q4_K_XL|Inkling|general|975|587|high|1000|Thinking Machines|41||1|1|1|1|||
  gemma4-26b-think|bjoernb/gemma4-26b-think:latest|Gemma 4 26B Think|reasoning|26|18|medium|256|Google (community)|||1|1|1|0|||
  medgemma1-5-thinking|jordimurgo/medgemma1.5-thinking:q4_K_M|MedGemma 1.5 Thinking|general|4.3|3.3|cpu-only|128|Google (community)|||1|1|0|0|||
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
  'minimax-m2-community-230b': 10, // MiniMax M2 (MoE) — official ollama.com listing shows retired 2026-06-16;
  // AA suggests MiniMax-M2.1 instead. Kept on the community namespace pending a verified successor row.
  'glm-5-2': 40, // GLM-5.2 MoE active params (hf.co GGUF pull, not the ollama.com :cloud tag)
  'laguna-xs-2-1': 3, // Laguna XS 2.1 — 33B-A3B MoE (Poolside)
  'laguna-s-2-1': 8, // Laguna S 2.1 — 118B-A8B MoE (Poolside)
  'lfm2-5-8b': 1.5, // LFM2.5 — 8.3B-A1.5B MoE (Liquid AI)
  'north-mini-code-1-0': 3, // North Mini Code 1.0 — 30B-A3B MoE (Cohere)
  inkling: 41, // Inkling — 975B-A41B sparse MoE (Thinking Machines)
  'gemma4-26b': 3.8, // Gemma 4 26B — 25.2B-A3.8B MoE (confirmed 2026-07-27 re-audit; was missing before)
  'qwen3-6-35b': 3, // Qwen 3.6 35B — 36B-A3B MoE (confirmed 2026-07-27 re-audit; was missing before)
  'gemma4-26b-think': 3.8, // Gemma 4 26B Think — 25.2B-A3.8B MoE, community thinking-mode variant
  'qwen3-coder-30b-lemonade': 3, // Qwen3-Coder-30B-A3B (Lemonade) — same 30B-A3B MoE arch as qwen3-30b above
};

/**
 * Shared TOON-row → CuratedModel mapper for both the Ollama catalog table and any
 * per-backend LLM table (e.g. `LEMONADE_LLM_TOON`) that follows the same column schema.
 * `backend` is a parameter rather than hardcoded so a second backend's table can reuse
 * every derived-field computation (tiers, footprint, MoE active-params) unchanged.
 */
function buildLlmModel(row: ToonRow, backend: InferenceBackendType): CuratedModel {
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
    backend,
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
// (not Ollama's) is what determines what's actually supported through this backend. No intel/agentic/
// perf figures are included — Artificial Analysis has not benchmarked these specific quantized
// checkpoints under Lemonade. All five are `recipe: "llamacpp"` in that file, so — like Ollama's own
// llama.cpp-based serving — they run across nvidia/amd/apple/cpu, not only AMD Ryzen AI NPU hardware.
const LEMONADE_LLM_TOON = `
llms[4|]{id,backendModelId,name,purpose,params,gb,tier,ctxK,creator,intel,agentic,reason,vision,tools,audio,tps,ttft,e2e}:
  llama3-2-3b-lemonade|Llama-3.2-3B-Instruct-GGUF|Llama 3.2 3B (Lemonade)|general|3|2.06|cpu-only||Meta|||0|0|0|0|||
  qwen3-8b-lemonade|Qwen3-8B-GGUF|Qwen 3 8B (Lemonade)|reasoning|8|5.25|low||Alibaba|||1|0|0|0|||
  gemma4-12b-lemonade|Gemma-4-12B-it-GGUF|Gemma 4 12B (Lemonade)|general|12|7.29|low||Google|||0|1|1|0|||
  qwen3-coder-30b-lemonade|Qwen3-Coder-30B-A3B-Instruct-GGUF|Qwen 3 Coder 30B (Lemonade)|coding|30|18.6|medium||Alibaba|||0|0|1|0|||
`;

const lemonadeLlms: CuratedModel[] = decodeToonTable(LEMONADE_LLM_TOON, 'llms').map((row) => buildLlmModel(row, 'lemonade'));

// Non-LLM models (voice + embedding) in TOON. Unlike the LLM table these carry explicit requirements
// (they aren't derived from a parameter count); purpose and input modality are derived from `modality`.
// Voice models run on the Lemonade backend; embedders on Ollama. cpu=1 means CPU inference is supported.
const EXTRAS_TOON = `
extras[8|]{id,backendModelId,backend,modality,name,creator,diskMb,footprintMb,minRamMb,recVramMb,minVramMb,ctx,minTier,cpu,pinned,tierHigh,tierMed,tierLow,tierCpu,desc}:
  kokoro-v1|kokoro-v1|lemonade|tts|Kokoro v1 TTS|Hexgrad|300|350|1024|512|0|0|cpu-only|1|1|recommended|recommended|recommended|recommended|High-quality text-to-speech. Low latency, natural sounding.
  whisper-large-v3-turbo|whisper-large-v3-turbo|lemonade|stt|Whisper Large v3 Turbo|OpenAI|1500|1500|8192|6144|4096|0|medium|0|0|recommended|recommended|not-recommended|not-recommended|OpenAI's speech-to-text model. Fast and accurate transcription.
  whisper-base|whisper-base|lemonade|stt|Whisper Base|OpenAI|150|200|1024|512|0|0|cpu-only|1|0|available|available|recommended|recommended|Lightweight speech-to-text for resource-constrained environments.
  nomic-embed-text|nomic-embed-text|ollama|embedding|Nomic Embed Text|Nomic|300|500|1024|512|0|8192|cpu-only|1|1|recommended|recommended|recommended|recommended|Local text-embedding model (768-dim). Default embeddings for CI memory / RAG (pgvector). Runs on any hardware.
  embeddinggemma|embeddinggemma|ollama|embedding|EmbeddingGemma|Google|622|700|1536|1024|0|2048|cpu-only|1|0|available|available|available|available|Google's 300M embedding model (768-dim, Matryoshka-truncatable to 512/256/128). Multilingual (100+ languages), 2K context. Drop-in pgvector replacement for Nomic at the same 768 dimensions, with stronger retrieval. Runs on any hardware.
  nomic-embed-text-v2-moe|nomic-embed-text-v2-moe|ollama|embedding|Nomic Embed Text v2 (MoE)|Nomic|900|900|2048|1024|0|512|cpu-only|1|0|available|available|available|available|Nomic Embed v2, a mixture-of-experts embedding model (~305M active / 475M total params, 768-dim). Multilingual (~100 languages) and pgvector-compatible with the 768-dim Nomic default. Runs on any hardware.
  qwen3-embedding|qwen3-embedding|ollama|embedding|Qwen3 Embedding (0.6B)|Alibaba|640|800|2048|1536|0|32768|cpu-only|1|0|available|available|available|available|Qwen3 Embedding 0.6B (1024-dim, 32K context). Tops the multilingual MTEB leaderboard for its size across 100+ languages. Note: 1024-dim — switching from the 768-dim default requires re-embedding existing memories. Runs on any hardware.
  nomic-embed-text-v1-lemonade|nomic-embed-text-v1-GGUF|lemonade|embedding|Nomic Embed Text v1 (Lemonade)|Nomic|80|150|1024|512|0|8192|cpu-only|1|0|recommended|recommended|recommended|recommended|Local text-embedding model (768-dim) served through Lemonade instead of Ollama, for hosts running Lemonade as their only local backend. Verified 2026-07-28 against lemonade-sdk/lemonade's server_models.json (checkpoint nomic-ai/nomic-embed-text-v1-GGUF:Q4_K_S, 0.0781GB). Runs on any hardware.
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

export const CURATED_MODELS: CuratedModel[] = [...generatedLlms, ...lemonadeLlms, ...extraModels];
