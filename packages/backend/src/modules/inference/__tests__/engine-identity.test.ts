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
    it('leaves a backend alone when the server names it', () => {
      expect(foreignEngineHealth('vllm', models('vllm'), 'http://host.docker.internal:8000')).toBeNull();
      expect(foreignEngineHealth('omlx', models('omlx'), 'http://host.docker.internal:8000')).toBeNull();
    });

    it('tells vLLM and oMLX apart when they share port 8000', () => {
      const notOurs = foreignEngineHealth('omlx', models('vllm'), 'http://host.docker.internal:8000');
      expect(notOurs).toMatchObject({ running: true, healthy: false, modelsLoaded: [] });
      expect(notOurs?.error).toContain("the vllm backend's server, not omlx's");
      expect(notOurs?.error).toContain('set OMLX_URL');
      expect(foreignEngineHealth('vllm', models('omlx'), 'http://host.docker.internal:8000')?.error).toContain(
        "the omlx backend's server, not vllm's",
      );
      expect(foreignEngineHealth('vllm', models('omlx'), 'http://host.docker.internal:8000')?.error).toContain('set VLLM_URL');
    });

    it('does not guess: a server that does not name itself, or names something unknown, is left as it was', () => {
      expect(foreignEngineHealth('omlx', models(), 'http://x:8000')).toBeNull();
      expect(foreignEngineHealth('omlx', models('acme-serve'), 'http://x:8000')).toBeNull();
      expect(foreignEngineHealth('vllm', models('llamacpp'), 'http://x:8000')).toBeNull();
      expect(foreignEngineHealth('omlx', { data: [] }, 'http://x:8000')).toBeNull();
    });
  });
});
