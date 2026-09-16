import { describe, expect, it } from 'vitest';
import {
  budgetPercent,
  combineLoadState,
  loadState,
  memoryBudgetRows,
  type MemoryBudgetSummary,
  peerLabel,
  poolModelIndex,
  type PoolNodeSummary,
  type PoolPeerSummary,
  poolReach,
  routingByNode,
  routingLogKeys,
  tokensByModel,
} from './use-dashboard-data';

/*
 * The dashboard's aggregation rules, tested away from React.
 *
 * Most of these assert an ABSENCE rather than a number: a peer that is unreachable, a
 * backend that is unhealthy, a counter no node reported. Each of those has an obvious
 * wrong answer (count it anyway, or render 0) that would look completely normal on screen,
 * which is exactly why they are pinned here.
 */

const peer = (over: Partial<PoolPeerSummary> & { id: string }): PoolPeerSummary => ({
  status: 'connected',
  enabled: true,
  ...over,
});

const withModels = (id: string, models: string[], over: Partial<PoolPeerSummary> = {}): PoolPeerSummary =>
  peer({ id, displayName: id, lastCapabilities: { backends: [{ type: 'ollama', healthy: true, modelsLoaded: models }] }, ...over });

const local: PoolNodeSummary = { backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['gemma3:1b', 'shared:7b'] }] };

describe('poolModelIndex', () => {
  it('groups each model by the nodes that can serve it, most widely held first', () => {
    const index = poolModelIndex(local, [withModels('core-2', ['shared:7b']), withModels('core-7', ['shared:7b', 'only-there:70b'])], 'this-hub');

    expect(index.map((row) => row.model)).toEqual(['shared:7b', 'gemma3:1b', 'only-there:70b']);
    expect(index[0]).toEqual({ model: 'shared:7b', nodes: ['core-2', 'core-7', 'this-hub'], backends: ['ollama'], local: true });
    expect(index.find((row) => row.model === 'only-there:70b')).toMatchObject({ nodes: ['core-7'], local: false });
  });

  it('excludes an unreachable peer, whose model list is a snapshot of a node that stopped answering', () => {
    const index = poolModelIndex(undefined, [withModels('gone', ['stale:7b'], { status: 'unreachable' })], 'this-hub');

    expect(index).toEqual([]);
  });

  it('excludes a peer the operator switched off, because routing will not use it', () => {
    const index = poolModelIndex(undefined, [withModels('parked', ['parked:7b'], { enabled: false })], 'this-hub');

    expect(index).toEqual([]);
  });

  it('excludes an unhealthy backend, which still reports models it cannot serve', () => {
    const node: PoolNodeSummary = { backends: [{ type: 'vllm', healthy: false, modelsLoaded: ['down:7b'] }] };

    expect(poolModelIndex(node, [], 'this-hub')).toEqual([]);
  });

  it('is empty, not broken, when nothing anywhere has a model loaded', () => {
    expect(poolModelIndex({ backends: [] }, [], 'this-hub')).toEqual([]);
  });
});

describe('poolReach', () => {
  it('counts only models a peer has that this node does not as the capacity pooling adds', () => {
    const reach = poolReach([withModels('core-2', ['shared:7b', 'peer-only:70b'])], local);

    expect(reach).toMatchObject({ connected: 1, unreachable: 0, reachableModels: 2, exclusiveModels: 1 });
  });

  it('reports unknown peer load as null, never as zero', () => {
    // A peer that never sent the counter and a peer sitting idle are different facts.
    expect(poolReach([withModels('quiet', ['a:1b'])], local).peerInFlight).toBeNull();
    expect(poolReach([withModels('busy', ['a:1b'], { inFlightRequests: 0 })], local).peerInFlight).toBe(0);
    expect(poolReach([withModels('busy', ['a:1b'], { inFlightRequests: 3 })], local).peerInFlight).toBe(3);
  });

  it('counts unreachable peers separately and does not treat them as reach', () => {
    const reach = poolReach([withModels('gone', ['stale:7b'], { status: 'unreachable' })], local);

    expect(reach).toMatchObject({ connected: 0, unreachable: 1, reachableModels: 0, exclusiveModels: 0 });
  });
});

describe('memoryBudgetRows', () => {
  const budget: MemoryBudgetSummary = {
    totalVramMb: 24_576,
    totalRamMb: 131_072,
    modelBudgetVramMb: 20_480,
    modelBudgetRamMb: 65_536,
    modelUsedVramMb: 8192,
    modelUsedRamMb: 4096,
    pinnedVramMb: 2048,
    pinnedRamMb: 0,
  };

  it('returns a row per memory pool that actually exists', () => {
    expect(memoryBudgetRows(budget).map((row) => row.kind)).toEqual(['vram', 'ram']);
  });

  it('drops the VRAM row on a unified-memory machine, where a zero total is by design', () => {
    // The backend forces totalVramMb to 0 when the GPU shares system memory and routes all
    // model memory into the RAM counters. An empty VRAM meter would read as "no GPU".
    const rows = memoryBudgetRows({ ...budget, totalVramMb: 0 });

    expect(rows.map((row) => row.kind)).toEqual(['ram']);
  });

  it('returns nothing at all when the budget never arrived, so a caller cannot render zeros', () => {
    expect(memoryBudgetRows(undefined)).toEqual([]);
  });
});

describe('budgetPercent', () => {
  it('reports the share of the budget in use', () => {
    expect(budgetPercent(5120, 10_240)).toBe(50);
  });

  it('clamps rather than reporting over 100% when usage exceeds the budget', () => {
    expect(budgetPercent(20_480, 10_240)).toBe(100);
  });

  it('is null, not zero, when there is no budget to be a share of', () => {
    expect(budgetPercent(0, 0)).toBeNull();
  });
});

describe('routingByNode', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      at: '2026-01-01T00:00:00Z',
      direction: 'outbound',
      path: '/v1/chat/completions',
      model: 'm',
      node: 'core-2.tail.ts.net',
      peerId: 'p',
      backend: 'ollama',
      candidates: 1,
      attempt: 1,
      failedOverFrom: [],
      pin: null,
      outcome: 'ok',
      ...over,
    }) as never;

  it('ignores inbound rows — their node SENT us work, it did not serve ours', () => {
    const counts = routingByNode([row({ direction: 'inbound', node: 'core-7.tail.ts.net' })], 'Unplaced');

    expect(counts.size).toBe(0);
  });

  it('does not credit the local node with a request nothing served', () => {
    const counts = routingByNode([row({ node: null, outcome: 'failed' })], 'Unplaced');

    expect(counts.get('local')).toBeUndefined();
    expect(counts.get('Unplaced')).toBe(1);
  });

  it('counts outbound work under the node that served it, shortened to its hostname', () => {
    const counts = routingByNode([row(), row(), row({ node: 'local' })], 'Unplaced');

    expect(counts.get('core-2')).toBe(2);
    expect(counts.get('local')).toBe(1);
  });

  it('keeps the three populations apart in one mixed log', () => {
    const counts = routingByNode([row(), row({ direction: 'inbound', node: 'beta-red.tail.ts.net' }), row({ node: null })], 'Unplaced');

    expect([...counts.entries()].sort()).toEqual([
      ['Unplaced', 1],
      ['core-2', 1],
    ]);
  });
});

describe('tokensByModel', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      at: '2026-01-01T00:00:00Z',
      direction: 'outbound',
      path: '/v1/chat/completions',
      model: 'qwen3.5:9b',
      node: 'core-2.tail.ts.net',
      backend: 'ollama',
      outcome: 'served',
      ...over,
    }) as never;

  it('sums usage.totalTokens for a model across held entries that report one', () => {
    const counts = tokensByModel([
      row({ usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }),
      row({ usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } }),
    ]);

    expect(counts.get('qwen3.5:9b')).toBe(180);
  });

  it('contributes nothing for an entry with no usage frame, rather than treating it as zero tokens', () => {
    const counts = tokensByModel([row(), row({ usage: null })]);

    expect(counts.size).toBe(0);
  });

  it('ignores inbound rows — a peer forward never carries a model we asked for', () => {
    const counts = tokensByModel([row({ direction: 'inbound', model: null, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })]);

    expect(counts.size).toBe(0);
  });

  it('keeps two models apart', () => {
    const counts = tokensByModel([
      row({ model: 'qwen3.5:9b', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
      row({ model: 'nomic-embed-text', usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 } }),
    ]);

    expect([...counts.entries()].sort()).toEqual([
      ['nomic-embed-text', 100],
      ['qwen3.5:9b', 15],
    ]);
  });
});

describe('routingLogKeys', () => {
  const entry = (at: string, model: string) => ({ at, direction: 'outbound', node: 'core-2', model, backend: 'ollama', status: 200 });

  it('keys a row by its content, so a new record at the head does not reshuffle the rest', () => {
    const older = [entry('t2', 'b'), entry('t1', 'a')];
    const withNewest = [entry('t3', 'c'), ...older];

    expect(routingLogKeys(older)).toEqual(routingLogKeys(withNewest).slice(1));
  });

  it('still gives two byte-identical records distinct keys', () => {
    const keys = routingLogKeys([entry('t1', 'a'), entry('t1', 'a')]);

    expect(new Set(keys).size).toBe(2);
  });

  it('has no keys for an empty log', () => {
    expect(routingLogKeys([])).toEqual([]);
  });
});

describe('peerLabel', () => {
  it('prefers the display name, then the short hostname, then the id', () => {
    expect(peerLabel({ id: 'x', displayName: 'beta-red', nodeFqdn: 'beta-red.tail.ts.net' })).toBe('beta-red');
    expect(peerLabel({ id: 'x', nodeFqdn: 'core-7.tail.ts.net' })).toBe('core-7');
    expect(peerLabel({ id: 'raw-uuid' })).toBe('raw-uuid');
  });
});

describe('loadState', () => {
  it('reads pending from isPending, so a failed query stops looking like a loading one', () => {
    // An errored query has isLoading false and no data; keying a skeleton off isLoading
    // would leave a failed fetch rendering a skeleton forever.
    expect(loadState({ isPending: false, isError: true })).toEqual({ pending: false, failed: true });
  });

  it('fails a combined panel if either of its sources failed', () => {
    expect(combineLoadState({ pending: false, failed: false }, { pending: false, failed: true })).toEqual({ pending: false, failed: true });
    expect(combineLoadState({ pending: true, failed: false }, { pending: false, failed: false })).toEqual({ pending: true, failed: false });
  });
});
