import { describe, expect, it } from 'vitest';
import { LEMONADE_REGISTRATIONS } from '../backends/lemonade.backend';
import { CURATED_MODELS } from '../catalog/curated-models';

/**
 * The LLM catalog is authored as a pipe-delimited TOON table and decoded at module load. These tests
 * exercise the decoder + derivation: counts, derived requirements, real context windows, and the
 * Artificial Analysis metadata (creator / intelligence index / capabilities / perf).
 */
describe('curated-models (TOON catalog)', () => {
  const byId = new Map(CURATED_MODELS.map((m) => [m.id, m]));
  const llms = CURATED_MODELS.filter((m) => m.modality === 'llm');

  it('decodes the full catalog (105 Ollama LLMs + 41 Lemonade LLMs + 8 vLLM LLMs + 64 oMLX LLMs + voice + embeddings) with unique ids', () => {
    expect(llms.filter((m) => m.backend === 'ollama').length).toBe(105);
    expect(llms.filter((m) => m.backend === 'lemonade').length).toBe(41);
    expect(llms.filter((m) => m.backend === 'vllm').length).toBe(8);
    expect(llms.filter((m) => m.backend === 'omlx').length).toBe(64);
    expect(llms.length).toBe(218);
    // 4 Ollama embeddings + 1 Lemonade embedding (nomic-embed-text-v1-5-lemonade).
    expect(CURATED_MODELS.filter((m) => m.modality === 'embedding').length).toBe(5);
    expect(CURATED_MODELS.filter((m) => m.modality === 'tts' || m.modality === 'stt').length).toBe(3);
    expect(new Set(CURATED_MODELS.map((m) => m.id)).size).toBe(CURATED_MODELS.length);
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

  it('leaves every row without a ramGb column on the historical diskMb x 1.1 footprint', () => {
    // Regression guard for the optional `ramGb` column added for mlx-dspark: adding it must not
    // have shifted a single pre-existing row's memory numbers.
    for (const m of CURATED_MODELS.filter((m) => m.modality === 'llm')) {
      expect(m.runtime.memoryFootprintMb, `${m.id} footprint`).toBe(Math.round(m.requirements.diskMb * 1.1));
      expect(m.requirements.minVramMb, `${m.id} minVram`).toBe(m.requirements.diskMb);
      expect(m.requirements.recommendedVramMb, `${m.id} recVram`).toBe(Math.round(m.requirements.diskMb * 1.1 + 1024));
      expect(m.requirements.minRamMb, `${m.id} minRam`).toBe(Math.round(m.requirements.diskMb * 1.15));
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

  it('gates oMLX rows to Apple Silicon only, never an NVIDIA VRAM budget', () => {
    const mlxRows = llms.filter((m) => m.backend === 'omlx');
    expect(mlxRows.length).toBe(64);
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

  it('derives requirements + context from the TOON row (gemma4-31b)', () => {
    const g = byId.get('gemma4-31b');
    expect(g).toBeDefined();
    expect(g?.backendModelId).toBe('gemma4:31b');
    expect(g?.parameterScale).toBe(31);
    // gb=20 → diskMb 20*1024, footprint ~1.1x.
    expect(g?.requirements.diskMb).toBe(20480);
    expect(g?.runtime.memoryFootprintMb).toBe(Math.round(20480 * 1.1));
    // ctxK=256 → 256000 (not the 131072 default).
    expect(g?.runtime.contextWindow).toBe(256000);
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
      // The MTP tag is its own download and a little larger; the size column must be the tag's, not the base's.
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
    expect(muse?.requirements.diskMb).toBe(18 * 1024);
    expect(muse?.tiers.medium).toBe('recommended');
  });

  it('derives requirements + metadata for Nemotron 3.5 Lightning', () => {
    const nemotron = byId.get('nemotron-3-5-lightning-30b');
    expect(nemotron).toBeDefined();
    expect(nemotron?.backendModelId).toBe('nemotron-3.5-lightning:30b');
    expect(nemotron?.metadata?.creator).toBe('NVIDIA');
    expect(nemotron?.activeParameterScale).toBe(3);
    expect(nemotron?.requirements.diskMb).toBe(25 * 1024);
    expect(nemotron?.tiers.medium).toBe('recommended');
  });

  it('never surfaces a cloud-proxy (`:cloud`-tagged) model — this catalog is local-only', () => {
    // Checked across every modality, not just LLMs — the rule is about the whole catalog.
    for (const m of CURATED_MODELS) {
      expect(m.backendModelId.endsWith(':cloud'), `${m.id} must not be a :cloud proxy`).toBe(false);
    }
  });

  it('contains no fabricated families/sizes (only ollama.com-verified entries)', () => {
    // Checked against BOTH the catalog `id` and the actual `backendModelId` pull tag — a fake family
    // slipped back into the catalog once (2026-08) under a dashed `id` (`mistral-medium-3-5-128b`) that
    // dodged an id-only check, while its `backendModelId` (`mistral-medium-3.5:128b`) was still exactly
    // the banned string. Never check id alone again.
    const ids = new Set(CURATED_MODELS.map((m) => m.id));
    const backendModelIds = CURATED_MODELS.map((m) => m.backendModelId);
    for (const fake of [
      'gemma4-300b',
      'gemma4-800b',
      'gemma4-3t',
      'qwen3-6-200b',
      'kimi-k2-6',
      'deepseek-v4-pro',
      'mistral-medium-3.5',
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
  // independent confirmation (a real browser, or an actual successful `ollama pull`).
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

  // 2026-08-12: mirrors the 2026-07-27 guard above for a second, independently-caught fabrication —
  // kept as its own list (rather than folded into the generic fabrication guard) so a future audit that
  // re-verifies one of these out-of-band has a single, obvious place to remove it from.
  it('does not re-add the 2026-08-12 unverified/fabricated Mistral Medium 3.5 row', () => {
    const ids = new Set(CURATED_MODELS.map((m) => m.id));
    for (const unverified of ['mistral-medium-3-5-128b']) {
      expect(ids.has(unverified), `unverified model ${unverified} must not be re-added without independent confirmation`).toBe(false);
    }
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
    expect(lemonadeEmbedders.map((m) => m.backendModelId)).toEqual(['nomic-embed-text-v1.5-GGUF']);
    expect(LEMONADE_REGISTRATIONS['nomic-embed-text-v1.5-GGUF']).toMatchObject({ checkpoint: expect.stringContaining('nomic-embed-text-v1.5') });
    for (const model of lemonadeEmbedders) {
      expect(model.backendModelId).not.toMatch(/nomic-embed-text-v1-GGUF/);
    }
  });
});
