import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_LISTING_DEADLINE_MS,
  MERGED_LISTING_PATHS,
  POOL_OWNED_BY,
  gatherListings,
  listedModelIds,
  mergeLocalListings,
  mergeModelListing,
  peerOnlyModels,
} from '../pool-model-listing';

describe('MERGED_LISTING_PATHS', () => {
  /*
   * Only the two listing paths merge. `/api/ps` is about this machine's memory and `/api/version`
   * about this machine's engine, so a peer's answer would not be an addition to either — it would
   * be a different node's answer to a question about this one.
   */
  it('covers the listing paths and nothing else local-only', () => {
    expect([...MERGED_LISTING_PATHS].sort()).toEqual(['/api/tags', '/v1/models']);
    for (const path of ['/api/ps', '/api/version', '/api/show']) {
      expect(MERGED_LISTING_PATHS.has(path)).toBe(false);
    }
  });
});

describe('listedModelIds', () => {
  it('reads OpenAI ids from /v1/models', () => {
    const body = { object: 'list', data: [{ id: 'a:1' }, { id: 'b:2' }] };
    expect(listedModelIds('/v1/models', body)).toEqual(['a:1', 'b:2']);
  });

  /* Ollama repeats the id in `name` and `model`; older engines filled only one of them. */
  it.each([
    ['both fields', { models: [{ name: 'a:1', model: 'a:1' }] }, ['a:1']],
    ['model only', { models: [{ model: 'a:1' }] }, ['a:1']],
    ['name only', { models: [{ name: 'a:1' }] }, ['a:1']],
  ])('reads Ollama ids from /api/tags with %s', (_label, body, expected) => {
    expect(listedModelIds('/api/tags', body)).toEqual(expected);
  });

  /*
   * A backend that answered 200 with something unexpected must not take the listing down — the
   * peer half is still worth serving. Every malformed shape reads as "named nothing".
   */
  it.each([null, undefined, 'a string', 42, {}, { data: 'not an array' }, { data: [{}] }, { data: [{ id: '' }] }])('reads no ids from %s', (body) => {
    expect(listedModelIds('/v1/models', body)).toEqual([]);
  });
});

describe('peerOnlyModels', () => {
  it('keeps what no local id already names', () => {
    expect(peerOnlyModels(['a:1'], ['a:1', 'b:2'])).toEqual(['b:2']);
  });

  /*
   * Candidate matching folds an untagged id with its `:latest` spelling — the case that sent every
   * OpenClaw memory write to a 502 for `nomic-embed-text` while the engine served
   * `nomic-embed-text:latest`. The listing must fold it too, or it advertises one model twice.
   */
  it.each([
    [['nomic-embed-text'], ['nomic-embed-text:latest']],
    [['nomic-embed-text:latest'], ['nomic-embed-text']],
  ])('treats %s and %s as the same model', (local, peer) => {
    expect(peerOnlyModels(local, peer)).toEqual([]);
  });

  /* Only the implicit tag folds: `qwen3:8b` and `qwen3:8b:latest` are different models. */
  it('folds nothing but the implicit :latest', () => {
    expect(peerOnlyModels(['qwen3:8b'], ['qwen3:8b:latest'])).toEqual(['qwen3:8b:latest']);
  });

  it('never repeats a model two peers both hold', () => {
    expect(peerOnlyModels([], ['nomic-embed-text', 'nomic-embed-text', 'nomic-embed-text:latest'])).toEqual(['nomic-embed-text']);
  });

  it('returns everything when this node listed nothing', () => {
    expect(peerOnlyModels([], ['a:1', 'b:2'])).toEqual(['a:1', 'b:2']);
  });
});

describe('mergeModelListing', () => {
  it('appends OpenAI rows after the local ones, and marks them', () => {
    const local = { object: 'list', data: [{ id: 'a:1', object: 'model', created: 7, owned_by: 'library' }] };

    expect(mergeModelListing('/v1/models', local, ['b:2'])).toEqual({
      object: 'list',
      data: [
        { id: 'a:1', object: 'model', created: 7, owned_by: 'library' },
        { id: 'b:2', object: 'model', created: 0, owned_by: POOL_OWNED_BY },
      ],
    });
  });

  /*
   * A peer publishes model names and nothing else, so size and digest are genuinely unknown. They
   * are emitted as the zero value their field requires; a fabricated size would be read as fact by
   * anything doing disk arithmetic. `details` is present but empty because clients index into it.
   */
  it('appends Ollama rows with unknown metadata left empty, not invented', () => {
    const merged = mergeModelListing('/api/tags', { models: [] }, ['b:2']) as { models: Array<Record<string, unknown>> };

    expect(merged.models[0]).toEqual({ name: 'b:2', model: 'b:2', modified_at: null, size: 0, digest: '', details: {} });
  });

  it('leaves a body untouched when there is nothing to add', () => {
    const local = { models: [{ name: 'a:1', model: 'a:1', size: 123 }] };
    expect(mergeModelListing('/api/tags', local, [])).toEqual(local);
  });

  /* A Hub with no local engine still has to describe the pool rather than fail. */
  it('builds a body from nothing when there was no local answer', () => {
    expect(mergeModelListing('/v1/models', null, ['b:2'])).toEqual({
      object: 'list',
      data: [{ id: 'b:2', object: 'model', created: 0, owned_by: POOL_OWNED_BY }],
    });
    expect(mergeModelListing('/api/tags', null, [])).toEqual({ models: [] });
  });

  /* Whatever else the engine put beside the list is its own; only the list is rewritten. */
  it('preserves sibling fields the local body carried', () => {
    const merged = mergeModelListing('/api/tags', { models: [], engine: 'ollama/0.30.11' }, []);
    expect(merged).toHaveProperty('engine', 'ollama/0.30.11');
  });
});

describe('mergeLocalListings', () => {
  it('returns a single body unchanged', () => {
    const body = { object: 'list', data: [{ id: 'a' }] };
    expect(mergeLocalListings('/v1/models', [body])).toBe(body);
  });

  it('appends later backends’ rows whole, skipping any model an earlier backend already listed', () => {
    const merged = mergeLocalListings('/v1/models', [
      { object: 'list', data: [{ id: 'qwen3:latest', owned_by: 'library' }] },
      { object: 'list', data: [{ id: 'qwen3' }, { id: 'Qwen3-8B-GGUF', owned_by: 'lemonade', created: 5 }] },
    ]);
    expect(merged).toEqual({
      object: 'list',
      data: [
        { id: 'qwen3:latest', owned_by: 'library' },
        { id: 'Qwen3-8B-GGUF', owned_by: 'lemonade', created: 5 },
      ],
    });
  });

  it('merges Ollama-shaped bodies by `model`/`name`', () => {
    const merged = mergeLocalListings('/api/tags', [
      { models: [{ name: 'a:latest', model: 'a:latest' }] },
      { models: [{ name: 'a' }, { name: 'b', size: 2 }] },
    ]);
    expect(merged).toEqual({
      models: [
        { name: 'a:latest', model: 'a:latest' },
        { name: 'b', size: 2 },
      ],
    });
  });
});

/*
 * Audit F5 of #1679: the merged listing waited for the slowest backend the health snapshot still
 * called healthy, and an engine wedged since the last poll held every app's listing for the whole
 * forward budget. These pin the deadline: what answers in time is kept, what does not is dropped
 * and aborted, and a listing never comes back empty because every backend was merely slow.
 */
describe('gatherListings', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  type FakeBackend = { fetchOne: (signal: AbortSignal) => Promise<unknown>; seen: { signal?: AbortSignal } };

  /** A backend that answers `body` after `ms`, or never (`null`), and rejects once its signal aborts. */
  function backendAnswering(body: unknown, ms: number | null): FakeBackend {
    const seen: { signal?: AbortSignal } = {};
    const fetchOne = (signal: AbortSignal) => {
      seen.signal = signal;
      return new Promise<unknown>((resolve, reject) => {
        const timer = ms === null ? undefined : setTimeout(() => resolve(body), ms);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
    };
    return { fetchOne, seen };
  }

  /** `standIns` is what `onDropped` hands back for a dropped backend: its last listing, when it has one. */
  function gather(backends: Record<string, FakeBackend>, standIns: Record<string, unknown> = {}) {
    const dropped: string[] = [];
    const settled = gatherListings(
      Object.keys(backends),
      (name, signal) => (backends[name] as FakeBackend).fetchOne(signal),
      LOCAL_LISTING_DEADLINE_MS,
      (name) => {
        dropped.push(name);
        return standIns[name];
      },
    );
    return { settled, dropped };
  }

  it('keeps every answer that arrives within the deadline, in backend order rather than arrival order', async () => {
    const { settled, dropped } = gather({ ollama: backendAnswering('ollama-body', 900), lemonade: backendAnswering('lemonade-body', 10) });

    await vi.advanceTimersByTimeAsync(900);

    await expect(settled).resolves.toEqual(['ollama-body', 'lemonade-body']);
    expect(dropped).toEqual([]);
  });

  it('drops a backend still out at the deadline once another has answered, and aborts its request', async () => {
    const wedged = backendAnswering('lemonade-body', null);
    const { settled, dropped } = gather({ ollama: backendAnswering('ollama-body', 5), lemonade: wedged });

    await vi.advanceTimersByTimeAsync(LOCAL_LISTING_DEADLINE_MS - 1);
    expect(dropped).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(settled).resolves.toEqual(['ollama-body']);
    expect(dropped).toEqual(['lemonade']);
    expect(wedged.seen.signal?.aborted).toBe(true);
  });

  // Review of #1709: a healthy engine slow for a moment took every model it holds out of the listing,
  // and ci-server checks its model against the listing on every call.
  it("keeps what onDropped hands back for a dropped backend, in that backend's place", async () => {
    const wedged = backendAnswering('ollama-body', null);
    const { settled, dropped } = gather(
      { ollama: wedged, vllm: backendAnswering('vllm-body', 5), lemonade: backendAnswering('lemonade-body', 10) },
      { ollama: 'ollama-last-listing' },
    );

    await vi.advanceTimersByTimeAsync(LOCAL_LISTING_DEADLINE_MS);

    await expect(settled).resolves.toEqual(['ollama-last-listing', 'vllm-body', 'lemonade-body']);
    expect(dropped).toEqual(['ollama']);
    expect(wedged.seen.signal?.aborted).toBe(true);
  });

  it('takes the first answer after the deadline when nothing had answered by then, and drops the rest', async () => {
    const wedged = backendAnswering('ollama-body', null);
    const { settled, dropped } = gather({ ollama: wedged, lemonade: backendAnswering('lemonade-body', LOCAL_LISTING_DEADLINE_MS + 1_000) });

    await vi.advanceTimersByTimeAsync(LOCAL_LISTING_DEADLINE_MS);
    expect(dropped).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(settled).resolves.toEqual(['lemonade-body']);
    expect(dropped).toEqual(['ollama']);
    expect(wedged.seen.signal?.aborted).toBe(true);
  });

  // A backend that answered with nothing usable is not an answer: it neither ends the wait for the
  // others at the deadline nor stands in for them after it.
  it('does not count an empty or failed answer, and is empty only when no backend answered', async () => {
    const failing: FakeBackend = { fetchOne: () => Promise.reject(new Error('ECONNREFUSED')), seen: {} };
    const { settled, dropped } = gather({
      ollama: backendAnswering(null, 5),
      vllm: failing,
      lemonade: backendAnswering('lemonade-body', LOCAL_LISTING_DEADLINE_MS + 500),
    });

    await vi.advanceTimersByTimeAsync(LOCAL_LISTING_DEADLINE_MS + 500);
    await expect(settled).resolves.toEqual(['lemonade-body']);
    expect(dropped).toEqual([]);

    const none = gather({ ollama: backendAnswering(null, 5), lemonade: backendAnswering(null, 10) });
    await vi.advanceTimersByTimeAsync(10);
    await expect(none.settled).resolves.toEqual([]);
  });

  it('answers at once when there is no backend to ask', async () => {
    await expect(gather({}).settled).resolves.toEqual([]);
  });
});
