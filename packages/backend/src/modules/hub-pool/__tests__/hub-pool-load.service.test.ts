import { describe, expect, it } from 'vitest';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from '../hub-pool-load.service';

describe('HubPoolLoadService', () => {
  describe('what the local engines are generating for', () => {
    it('counts a local generation in the queue depth and names its model on its engine until it is released', () => {
      const load = new HubPoolLoadService();
      const generation = { backend: 'ollama', model: 'qwen3.8:27b' } as const;

      load.acquire(LOCAL_CANDIDATE_KEY, generation);

      expect(load.localInFlight()).toBe(1);
      expect(load.localGenerationsOn('ollama')).toEqual(['qwen3.8:27b']);
      expect(load.localGenerationsOn('vllm')).toEqual([]);

      load.release(LOCAL_CANDIDATE_KEY, generation);

      expect(load.localInFlight()).toBe(0);
      expect(load.localGenerationsOn('ollama')).toEqual([]);
    });

    it('names a model once however many generations it has, and keeps it until the last one ends', () => {
      const load = new HubPoolLoadService();
      const turn = { backend: 'ollama', model: 'qwen3.6:35b' } as const;

      load.acquire(LOCAL_CANDIDATE_KEY, turn);
      load.acquire(LOCAL_CANDIDATE_KEY, turn);
      load.release(LOCAL_CANDIDATE_KEY, turn);

      expect(load.localGenerationsOn('ollama')).toEqual(['qwen3.6:35b']);
      load.release(LOCAL_CANDIDATE_KEY, turn);
      expect(load.localGenerationsOn('ollama')).toEqual([]);
    });

    it('folds the implicit :latest tag, so one model is never two', () => {
      const load = new HubPoolLoadService();

      load.acquire(LOCAL_CANDIDATE_KEY, { backend: 'ollama', model: 'llama3.2' });
      load.acquire(LOCAL_CANDIDATE_KEY, { backend: 'ollama', model: 'llama3.2:latest' });

      expect(load.localGenerationsOn('ollama')).toEqual(['llama3.2:latest']);
    });

    it('counts work without a generation in the queue depth only — an embedding or a model-less forward names nothing', () => {
      const load = new HubPoolLoadService();

      load.acquire(LOCAL_CANDIDATE_KEY);

      expect(load.localInFlight()).toBe(1);
      expect(load.localGenerationsOn('ollama')).toEqual([]);
    });

    it('records no generation against a peer, whose engines are its own to report', () => {
      const load = new HubPoolLoadService();

      load.acquire('peer-1', { backend: 'ollama', model: 'qwen3.8:27b' });

      expect(load.get('peer-1')).toBe(1);
      expect(load.localGenerationsOn('ollama')).toEqual([]);
    });
  });
});
