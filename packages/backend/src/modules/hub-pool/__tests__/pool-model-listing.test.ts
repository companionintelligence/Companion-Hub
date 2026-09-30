import { describe, expect, it } from 'vitest';
import { MERGED_LISTING_PATHS, POOL_OWNED_BY, listedModelIds, mergeLocalListings, mergeModelListing, peerOnlyModels } from '../pool-model-listing';

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
