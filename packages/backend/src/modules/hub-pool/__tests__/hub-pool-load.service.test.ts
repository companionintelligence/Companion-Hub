import { describe, expect, it } from 'vitest';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from '../hub-pool-load.service';

describe('HubPoolLoadService', () => {
  describe('what the local engines are generating for', () => {
    it('counts a local generation in the queue depth and names its model and window on its engine until it is released', () => {
      const load = new HubPoolLoadService();
      const generation = { backend: 'ollama', model: 'qwen3.8:27b', numCtx: 65_536 } as const;

      load.acquire(LOCAL_CANDIDATE_KEY, generation);

      expect(load.localInFlight()).toBe(1);
      expect(load.localGenerationsOn('ollama')).toEqual([{ model: 'qwen3.8:27b', numCtx: 65_536 }]);
      expect(load.localGenerationsOn('vllm')).toEqual([]);

      load.release(LOCAL_CANDIDATE_KEY, generation);

      expect(load.localInFlight()).toBe(0);
      expect(load.localGenerationsOn('ollama')).toEqual([]);
    });

    it('names a model once per window however many generations it has, and keeps it until the last one ends', () => {
      const load = new HubPoolLoadService();
      const turn = { backend: 'ollama', model: 'qwen3.6:35b', numCtx: null } as const;

      load.acquire(LOCAL_CANDIDATE_KEY, turn);
      load.acquire(LOCAL_CANDIDATE_KEY, turn);
      load.release(LOCAL_CANDIDATE_KEY, turn);

      expect(load.localGenerationsOn('ollama')).toEqual([{ model: 'qwen3.6:35b', numCtx: null }]);
      load.release(LOCAL_CANDIDATE_KEY, turn);
      expect(load.localGenerationsOn('ollama')).toEqual([]);
    });

    it('keeps one model at two windows apart: Ollama runs them as two loads, not one', () => {
      const load = new HubPoolLoadService();
      const native = { backend: 'ollama', model: 'qwen3.6:35b', numCtx: 65_536 } as const;
      const v1 = { backend: 'ollama', model: 'qwen3.6:35b', numCtx: null } as const;

      load.acquire(LOCAL_CANDIDATE_KEY, v1);
      load.acquire(LOCAL_CANDIDATE_KEY, native);

      expect(load.localGenerationsOn('ollama')).toEqual([
        { model: 'qwen3.6:35b', numCtx: null },
        { model: 'qwen3.6:35b', numCtx: 65_536 },
      ]);

      load.release(LOCAL_CANDIDATE_KEY, v1);

      expect(load.localGenerationsOn('ollama')).toEqual([{ model: 'qwen3.6:35b', numCtx: 65_536 }]);
    });

    it('folds the implicit :latest tag, so one model is never two', () => {
      const load = new HubPoolLoadService();

      load.acquire(LOCAL_CANDIDATE_KEY, { backend: 'ollama', model: 'llama3.2', numCtx: null });
      load.acquire(LOCAL_CANDIDATE_KEY, { backend: 'ollama', model: 'llama3.2:latest', numCtx: null });

      expect(load.localGenerationsOn('ollama')).toEqual([{ model: 'llama3.2:latest', numCtx: null }]);
    });

    it('counts work without a generation in the queue depth only — an embedding or a model-less forward names nothing', () => {
      const load = new HubPoolLoadService();

      load.acquire(LOCAL_CANDIDATE_KEY);

      expect(load.localInFlight()).toBe(1);
      expect(load.localGenerationsOn('ollama')).toEqual([]);
    });

    it('records no generation against a peer, whose engines are its own to report', () => {
      const load = new HubPoolLoadService();

      load.acquire('peer-1', { backend: 'ollama', model: 'qwen3.8:27b', numCtx: null });

      expect(load.get('peer-1')).toBe(1);
      expect(load.localGenerationsOn('ollama')).toEqual([]);
    });
  });
});
