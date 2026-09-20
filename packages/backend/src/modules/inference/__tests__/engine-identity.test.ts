import { describe, expect, it } from 'vitest';
import { foreignEngineHealth, openAiModelIds, openAiModelOwner } from '../backends/engine-identity';

const models = (owner?: string, ids: string[] = ['Qwen/Qwen3.5-9B']) => ({
  object: 'list',
  data: ids.map((id) => ({ id, object: 'model', ...(owner ? { owned_by: owner } : {}) })),
});

describe('engine-identity', () => {
  describe('openAiModelOwner', () => {
    it('reads data[0].owned_by, lowercased and trimmed', () => {
      expect(openAiModelOwner(models(' VLLM '))).toBe('vllm');
    });

    it('is empty when the field, the list or the body is absent', () => {
      expect(openAiModelOwner(models())).toBe('');
      expect(openAiModelOwner({ data: [] })).toBe('');
      expect(openAiModelOwner(null)).toBe('');
      expect(openAiModelOwner('not json')).toBe('');
    });
  });

  describe('openAiModelIds', () => {
    it('keeps only string ids', () => {
      expect(openAiModelIds({ data: [{ id: 'a' }, { id: '' }, { id: 7 }, {}] })).toEqual(['a', '7']);
      expect(openAiModelIds({})).toEqual([]);
    });
  });

  describe('foreignEngineHealth', () => {
    // The fleet case: vLLM on host port 8000, which is also the default for mtplx and lucebox.
    // The Hub reported all three healthy with vLLM's model until the owned_by claim was honoured.
    it('leaves a backend alone when the server names it', () => {
      expect(foreignEngineHealth('vllm', models('vllm'), 'http://host.docker.internal:8000')).toBeNull();
      expect(foreignEngineHealth('lucebox', models('dflash'), 'http://host.docker.internal:8216')).toBeNull();
      expect(foreignEngineHealth('mtplx', models('mtplx'), 'http://host.docker.internal:8000')).toBeNull();
    });

    it('reports a shared-port backend unhealthy when the server names another engine, and says which env var points it at its own', () => {
      const health = foreignEngineHealth('mtplx', models('vllm'), 'http://host.docker.internal:8000');
      expect(health).toMatchObject({ running: true, healthy: false, modelsLoaded: [] });
      expect(health?.error).toContain('names itself "vllm"');
      expect(health?.error).toContain("the vllm backend's server, not mtplx's");
      expect(health?.error).toContain('set MTPLX_URL');

      expect(foreignEngineHealth('lucebox', models('vllm'), 'http://x:8000')?.error).toContain('set SPECULATIVE_INFERENCE_URL');
      expect(foreignEngineHealth('vllm', models('dflash'), 'http://x:8000')?.error).toContain('set VLLM_URL');
    });

    it('does not guess: a server that does not name itself, or names something unknown, is left as it was', () => {
      expect(foreignEngineHealth('mtplx', models(), 'http://x:8000')).toBeNull();
      expect(foreignEngineHealth('mtplx', models('acme-serve'), 'http://x:8000')).toBeNull();
      expect(foreignEngineHealth('mtplx', { data: [] }, 'http://x:8000')).toBeNull();
    });
  });
});
