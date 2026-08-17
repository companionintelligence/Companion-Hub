import { describe, expect, it } from 'vitest';
import { CURATED_MODELS } from '../catalog/curated-models';

/**
 * The LLM catalog is authored as a pipe-delimited TOON table and decoded at module load. These tests
 * exercise the decoder + derivation: counts, derived requirements, real context windows, and the
 * Artificial Analysis metadata (creator / intelligence index / capabilities / perf).
 */
describe('curated-models (TOON catalog)', () => {
  const byId = new Map(CURATED_MODELS.map((m) => [m.id, m]));
  const llms = CURATED_MODELS.filter((m) => m.modality === 'llm');

  it('decodes the full catalog (84 Ollama LLMs + 4 Lemonade LLMs + 8 vLLM LLMs + voice + embeddings) with unique ids', () => {
    expect(llms.filter((m) => m.backend === 'ollama').length).toBe(84);
    expect(llms.filter((m) => m.backend === 'lemonade').length).toBe(4);
    expect(llms.filter((m) => m.backend === 'vllm').length).toBe(8);
    expect(llms.length).toBe(96);
    // 4 Ollama embeddings + 1 Lemonade embedding (nomic-embed-text-v1-lemonade).
    expect(CURATED_MODELS.filter((m) => m.modality === 'embedding').length).toBe(5);
    expect(CURATED_MODELS.filter((m) => m.modality === 'tts' || m.modality === 'stt').length).toBe(3);
    expect(new Set(CURATED_MODELS.map((m) => m.id)).size).toBe(CURATED_MODELS.length);
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
    }
    // vLLM LLM tags are HuggingFace repo ids (`org/model`) served as-is by `vllm serve`,
    // and their quantization reflects the served precision, never Ollama's q4_K_M default.
    for (const m of llms.filter((m) => m.backend === 'vllm')) {
      expect(m.backendModelId, `${m.id} tag`).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(['bf16', 'mxfp4'], `${m.id} quantization`).toContain(m.runtime.quantization);
    }
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
    expect(llama?.metadata?.intelligenceIndex).toBe(9);
    expect(llama?.metadata?.perf?.tokensPerSec).toBe(85.1);

    const gemma = byId.get('gemma4-31b');
    expect(gemma?.metadata?.creator).toBe('Google');
    expect(gemma?.metadata?.capabilities?.vision).toBe(true);
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
});
