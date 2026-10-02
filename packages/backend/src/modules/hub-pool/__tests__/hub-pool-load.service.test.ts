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

  // What a load must not evict: every model an engine is doing work for, not only the ones with a
  // turn running. An embedding batch holds the embedder's runner just as a turn holds its model's.
  describe('what the local engines are busy with', () => {
    const memoryBatch = { backend: 'ollama', model: 'nomic-embed-text' } as const;

    it('names a model an embedding batch is running on as busy, and never as a generation', () => {
      const load = new HubPoolLoadService();

      load.acquire(LOCAL_CANDIDATE_KEY, undefined, memoryBatch);

      expect(load.localInFlight()).toBe(1);
      expect(load.localBusyModelsOn('ollama')).toEqual([{ model: 'nomic-embed-text:latest' }]);
      expect(load.localGenerationsOn('ollama')).toEqual([]);

      load.release(LOCAL_CANDIDATE_KEY, undefined, memoryBatch);

      expect(load.localBusyModelsOn('ollama')).toEqual([]);
    });

    it('names each busy model once, whatever mix of turns and batches it has, until the last one ends', () => {
      const load = new HubPoolLoadService();
      const turn = { backend: 'ollama', model: 'gemma4:e4b', numCtx: 65_536 } as const;
      const v1Turn = { backend: 'ollama', model: 'gemma4:e4b', numCtx: null } as const;

      load.acquire(LOCAL_CANDIDATE_KEY, turn);
      load.acquire(LOCAL_CANDIDATE_KEY, v1Turn);
      load.acquire(LOCAL_CANDIDATE_KEY, undefined, memoryBatch);
      load.acquire(LOCAL_CANDIDATE_KEY, undefined, { backend: 'ollama', model: 'nomic-embed-text:latest' });

      expect(load.localBusyModelsOn('ollama')).toEqual([{ model: 'gemma4:e4b' }, { model: 'nomic-embed-text:latest' }]);
      expect(load.localBusyModelsOn('lemonade')).toEqual([]);

      load.release(LOCAL_CANDIDATE_KEY, turn);
      load.release(LOCAL_CANDIDATE_KEY, undefined, memoryBatch);
      expect(load.localBusyModelsOn('ollama')).toEqual([{ model: 'gemma4:e4b' }, { model: 'nomic-embed-text:latest' }]);

      load.release(LOCAL_CANDIDATE_KEY, v1Turn);
      load.release(LOCAL_CANDIDATE_KEY, undefined, { backend: 'ollama', model: 'nomic-embed-text:latest' });
      expect(load.localBusyModelsOn('ollama')).toEqual([]);
    });

    it('records no busy model against a peer, whose engines are its own to report', () => {
      const load = new HubPoolLoadService();

      load.acquire('peer-1', undefined, memoryBatch);

      expect(load.get('peer-1')).toBe(1);
      expect(load.localBusyModelsOn('ollama')).toEqual([]);
    });
  });

  describe("what a peer's self-report counted that is not this node's own forwards", () => {
    it('takes out the forwards that were in flight when the report was read, and keeps the rest', () => {
      const load = new HubPoolLoadService();
      load.acquire('peer-1');
      load.noteReport('peer-1', load.get('peer-1'));

      // It reported 3: our one, and two of its own apps' or another node's.
      expect(load.externalLoad('peer-1', 3)).toBe(2);
      expect(load.externalLoad('peer-1', 1)).toBe(0);
    });

    it('reads a report that is lower than what we forwarded, or negative, as no outside work', () => {
      const load = new HubPoolLoadService();
      load.noteReport('peer-1', 2);

      expect(load.externalLoad('peer-1', 0)).toBe(0);
      expect(load.externalLoad('peer-1', -4)).toBe(0);
    });

    it('takes nothing out of a peer no report was noted for, so a restart reads it as before', () => {
      const load = new HubPoolLoadService();

      expect(load.externalLoad('peer-1', 2)).toBe(2);
    });

    it('replaces the figure with each report, and a report with nothing forwarded clears it', () => {
      const load = new HubPoolLoadService();
      load.noteReport('peer-1', 2);
      load.noteReport('peer-1', 1);
      expect(load.externalLoad('peer-1', 2)).toBe(1);

      load.noteReport('peer-1', 0);
      expect(load.externalLoad('peer-1', 2)).toBe(2);
    });

    it('forgets the peers that are no longer polled', () => {
      const load = new HubPoolLoadService();
      load.noteReport('peer-1', 1);
      load.noteReport('peer-2', 1);

      load.forgetReportsExcept(new Set(['peer-2']));

      expect(load.externalLoad('peer-1', 1)).toBe(1);
      expect(load.externalLoad('peer-2', 1)).toBe(0);
    });
  });
});
