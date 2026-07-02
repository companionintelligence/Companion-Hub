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

  it('decodes the full catalog (60 LLMs + voice + embeddings) with unique ids', () => {
    expect(llms.length).toBe(60);
    expect(CURATED_MODELS.filter((m) => m.modality === 'embedding').length).toBe(4);
    expect(CURATED_MODELS.filter((m) => m.modality === 'tts' || m.modality === 'stt').length).toBe(3);
    expect(new Set(CURATED_MODELS.map((m) => m.id)).size).toBe(CURATED_MODELS.length);
  });

  it('gives every model a real, pullable backend tag and sane derived requirements', () => {
    for (const m of CURATED_MODELS) {
      expect(m.backendModelId, `${m.id} backendModelId`).toBeTruthy();
      expect(m.requirements.diskMb, `${m.id} diskMb`).toBeGreaterThan(0);
      expect(m.runtime.memoryFootprintMb, `${m.id} footprint`).toBeGreaterThan(0);
    }
    // LLM tags are the bare `family:size` default (the q4_K_M build ollama pulls by default).
    for (const m of llms) {
      expect(m.backendModelId, `${m.id} tag`).toContain(':');
      expect(m.runtime.quantization).toBe('q4_K_M');
    }
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
    expect(llama?.metadata?.intelligenceIndex).toBe(14.5);
    expect(llama?.metadata?.perf?.tokensPerSec).toBe(80);

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
    const glm = byId.get('glm-5-2-cloud');
    expect(glm).toBeDefined();
    expect(glm?.backendModelId).toBe('glm-5.2:cloud');
    expect(glm?.parameterScale).toBeGreaterThan(70);
    expect(glm?.tiers.high).toBe('recommended');
  });

  it('contains no fabricated families/sizes (only ollama.com-verified entries)', () => {
    const ids = new Set(CURATED_MODELS.map((m) => m.id));
    for (const fake of ['gemma4-300b', 'gemma4-800b', 'gemma4-3t', 'qwen3-6-200b', 'kimi-k2-6', 'deepseek-v4-pro', 'mistral-medium-3.5']) {
      expect(ids.has(fake), `fabricated model ${fake} must not exist`).toBe(false);
    }
  });
});
