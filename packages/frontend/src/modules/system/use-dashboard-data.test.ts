import { describe, expect, it } from 'vitest';
import {
  budgetPercent,
  combineLoadState,
  estimatedPromptTokens,
  gpuProcessOwner,
  type HardwareSummary,
  hostRamUsedMb,
  isExhausted,
  isUnplaced,
  loadState,
  memoryBudgetRows,
  type MemoryBudgetSummary,
  memoryReconciliation,
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

  it('files each engine under the pool its figure was counted against', () => {
    const rows = memoryBudgetRows({
      ...budget,
      usage: {
        sampledAt: '2026-09-20T00:00:00Z',
        backends: [
          { backend: 'ollama', models: ['gemma4:e4b'], pool: 'vram', usedMb: 1533, source: 'engine' },
          { backend: 'vllm', models: ['Qwen/Qwen2.5-3B-Instruct-AWQ'], pool: 'vram', usedMb: 6104, source: 'process' },
        ],
      },
    });

    expect(rows.find((row) => row.kind === 'vram')?.engines.map((entry) => entry.backend)).toEqual(['ollama', 'vllm']);
    expect(rows.find((row) => row.kind === 'ram')?.engines).toEqual([]);
    expect(rows.every((row) => row.incomplete === false)).toBe(true);
  });

  it('marks a pool incomplete when an engine in it holds a model nobody could size', () => {
    // The used figure is then a floor: the engine is resident, its footprint is unknown, and a
    // reader treating the remainder as free would over-admit — so the row says so.
    const rows = memoryBudgetRows({
      ...budget,
      usage: {
        sampledAt: '2026-09-20T00:00:00Z',
        backends: [{ backend: 'omlx', models: ['qwen3.6-27b'], pool: 'vram', usedMb: null, source: 'unmeasured' }],
      },
    });

    expect(rows.find((row) => row.kind === 'vram')?.incomplete).toBe(true);
    expect(rows.find((row) => row.kind === 'ram')?.incomplete).toBe(false);
  });

  it('treats a budget from an older Hub, with no usage block, as complete rather than unknown', () => {
    expect(memoryBudgetRows(budget).every((row) => row.incomplete === false && row.engines.length === 0)).toBe(true);
  });
});

describe('hostRamUsedMb', () => {
  it('takes the measured usedMb when the Hub sends one', () => {
    // core-2 as `free -m` sees it: 128085 total, 53052 available, 75033 used.
    expect(hostRamUsedMb({ ram: { totalMb: 128_085, availableMb: 53_052, usedMb: 75_033, sampledAt: '2026-09-20T12:00:00.000Z' } })).toBe(75_033);
  });

  it('derives it from total and available on a Hub that predates usedMb', () => {
    expect(hostRamUsedMb({ ram: { totalMb: 128_085, availableMb: 124_547 } })).toBe(3538);
  });

  it('is null, not zero, when the profile has no RAM figures to speak of', () => {
    expect(hostRamUsedMb(undefined)).toBeNull();
    expect(hostRamUsedMb({ ram: { totalMb: 128_085 } })).toBeNull();
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

  const byNode = (entries: never[]) => routingByNode(entries, 'Unplaced', 'All candidates failed');

  it('ignores inbound rows — their node SENT us work, it did not serve ours', () => {
    const counts = byNode([row({ direction: 'inbound', node: 'core-7.tail.ts.net' })]);

    expect(counts.size).toBe(0);
  });

  it('does not credit the local node with a request nothing served', () => {
    const counts = byNode([row({ node: null, candidates: 0, outcome: 'failed' })]);

    expect(counts.get('local')).toBeUndefined();
    expect(counts.get('Unplaced')).toBe(1);
  });

  it('counts outbound work under the node that served it, shortened to its hostname', () => {
    const counts = byNode([row(), row(), row({ node: 'local' })]);

    expect(counts.get('core-2')).toBe(2);
    expect(counts.get('local')).toBe(1);
  });

  it('keeps the populations apart in one mixed log', () => {
    const counts = byNode([
      row(),
      row({ direction: 'inbound', node: 'beta-red.tail.ts.net' }),
      row({ node: null, candidates: 0, outcome: 'failed' }),
      row({ node: null, candidates: 9, attempt: 9, outcome: 'failed', failedOverFrom: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }),
    ]);

    expect([...counts.entries()].sort()).toEqual([
      ['All candidates failed', 1],
      ['Unplaced', 1],
      ['core-2', 1],
    ]);
  });

  /*
   * core-2, 2026-09-26T23:51:12Z: an agent turn nine nodes each tried and dropped. It was filed as
   * "Unplaced" — "a request no node took" — beside a feed row reading "+9 tried".
   */
  it('files a request every candidate failed under its own label, not as one nobody took', () => {
    const counts = byNode([
      row({ node: null, candidates: 9, attempt: 9, outcome: 'failed', failedOverFrom: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }),
    ]);

    expect(counts.get('Unplaced')).toBeUndefined();
    expect(counts.get('All candidates failed')).toBe(1);
  });
});

describe('isUnplaced / isExhausted', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({ at: '2026-01-01T00:00:00Z', direction: 'outbound', node: null, outcome: 'failed', failedOverFrom: [], ...over }) as never;

  it('calls a request unplaced only when there was no candidate to ask', () => {
    expect(isUnplaced(row({ candidates: 0 }))).toBe(true);
    expect(isUnplaced(row({ candidates: 9, failedOverFrom: ['a'] }))).toBe(false);
    expect(isExhausted(row({ candidates: 9, failedOverFrom: ['a'] }))).toBe(true);
    expect(isExhausted(row({ candidates: 0 }))).toBe(false);
  });

  it('never calls a caller who hung up exhausted — the pool did not fail it', () => {
    expect(isExhausted(row({ candidates: 3, clientClosed: true }))).toBe(false);
  });

  it('never calls an inbound row either — its node is the sender', () => {
    expect(isUnplaced(row({ direction: 'inbound', candidates: 0 }))).toBe(false);
    expect(isExhausted(row({ direction: 'inbound', candidates: 1 }))).toBe(false);
  });

  it('falls back on a Hub too old to report candidates: tried-and-failed-over is exhausted, the rest unplaced', () => {
    expect(isUnplaced(row())).toBe(true);
    expect(isUnplaced(row({ failedOverFrom: ['a'] }))).toBe(false);
    expect(isExhausted(row({ failedOverFrom: ['a'] }))).toBe(true);
  });
});

describe('estimatedPromptTokens', () => {
  it("prefers the routing decision's own estimate, then bytes / 4, then nothing", () => {
    expect(estimatedPromptTokens({ at: '', direction: 'outbound', bodyBytes: 155_982, throughput: { estimatedTokens: 38_979 } })).toBe(38_979);
    expect(estimatedPromptTokens({ at: '', direction: 'outbound', bodyBytes: 155_982 })).toBe(38_996);
    expect(estimatedPromptTokens({ at: '', direction: 'outbound', bodyBytes: null })).toBeNull();
  });
});

/*
 * The three Strix Halo nodes the spec was measured on, 2026-09-27, as the dashboard received them:
 * host RAM in use (`/inference/hardware`), what the workloads' containers held (the leaf rollup),
 * and what the engines reported holding (`/inference/memory`). sysfs on the same hosts is in the
 * comments — it is the truth this function cannot see, only infer.
 */
describe('memoryReconciliation', () => {
  const MB = 1024 ** 2;
  const unified = (usedMb: number, totalMb: number): HardwareSummary => ({
    gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: totalMb, unifiedMemory: true },
    ram: { totalMb, availableMb: totalMb - usedMb, usedMb, sampledAt: '2026-09-27T18:00:50.475Z' },
  });
  const budget = (modelUsedRamMb: number, over: Partial<MemoryBudgetSummary> = {}): MemoryBudgetSummary => ({
    totalVramMb: 0,
    totalRamMb: 0,
    modelUsedVramMb: 0,
    modelUsedRamMb,
    usage: { sampledAt: '2026-09-27T18:00:50Z', backends: [{ backend: 'ollama', pool: 'ram', usedMb: modelUsedRamMb, source: 'engine' }] },
    ...over,
  });

  it('says the models are outside what the host counts on core-1 (96 GiB BIOS carve-out; host sees 31G)', () => {
    // Host: 6,445 MB in use. Workloads: 492 MB. Ollama: 16,902 MB of models "in 29G of budget".
    const result = memoryReconciliation(unified(6445, 31_357), { memoryBytes: 492 * MB }, budget(16_902));

    expect(result?.kind).toBe('outside-host');
    expect(result?.sizeMb).toBe(16_902 - (6445 - 492));
  });

  it('finds host RAM nothing reports on fzzy (~42 GiB of GTT held by dflash_server and vLLM)', () => {
    // Host: 50,572 MB in use. Workloads: 818 MB. Engines: 314 MB (vLLM's process read).
    const result = memoryReconciliation(unified(50_572, 125_781), { memoryBytes: 818 * MB }, budget(314));

    expect(result?.kind).toBe('unaccounted');
    // ~48 GB — the GTT the budget cannot see, plus the engines' host-side overhead.
    expect(Math.round((result?.sizeMb ?? 0) / 1024)).toBe(48);
  });

  it('stays quiet on core-2, where the figures add up', () => {
    // Host: 32,702 MB in use. Workloads: ~1.7 GB. Ollama (rocm-smi): 24,824 MB.
    expect(memoryReconciliation(unified(32_702, 128_085), { memoryBytes: 1_779_000_000 }, budget(24_824))).toBeNull();
  });

  it('says nothing about a discrete card, where engines holding more VRAM than the host has RAM in use is normal', () => {
    const discrete: HardwareSummary = { ...unified(6445, 31_357), gpu: { available: true, vendor: 'nvidia', unifiedMemory: false } };

    expect(memoryReconciliation(discrete, { memoryBytes: 492 * MB }, budget(16_902))).toBeNull();
  });

  it('reconciles nothing against RAM figures that are not a live reading', () => {
    const snapshot = unified(6445, 31_357);
    delete snapshot.ram?.sampledAt;

    expect(memoryReconciliation(snapshot, { memoryBytes: 492 * MB }, budget(16_902))).toBeNull();
  });

  it('waits for the container rollup rather than calling every workload byte unaccounted', () => {
    expect(memoryReconciliation(unified(50_572, 125_781), null, budget(314))).toBeNull();
  });

  it('withholds "unaccounted" when an engine holds a model nobody could size — that may be where it went', () => {
    const unsized = budget(314, {
      usage: { backends: [{ backend: 'vllm', pool: 'ram', usedMb: null, source: 'unmeasured' }] },
    });

    expect(memoryReconciliation(unified(50_572, 125_781), { memoryBytes: 818 * MB }, unsized)).toBeNull();
  });
});

/*
 * The backend's own rule (`memory-manager.service.ts`), applied to the rows the container sampler
 * could not give to a workload. Each case is one the backend decides the same way, so the GPU tile
 * and Model memory can never disagree about whose memory a process holds.
 */
describe('gpuProcessOwner', () => {
  const ollama = { backend: 'ollama', pool: 'ram' as const, usedMb: 24_824, source: 'process' as const };

  it("gives core-2's bare llama-server to Ollama, the only llama.cpp engine holding a model, and says Model memory counts it", () => {
    expect(gpuProcessOwner('llama-server', [ollama])).toEqual({ engine: 'ollama', inModelMemory: true });
  });

  it('names an engine by its process wherever the vendor tool spells it, and marks it counted only when Model memory was sized from it', () => {
    expect(gpuProcessOwner('VLLM::EngineCor', [{ backend: 'vllm', usedMb: 314, source: 'process' }])).toEqual({
      engine: 'vllm',
      inModelMemory: true,
    });
    // Ollama sized from `/api/ps` instead: the process is still Ollama's, but this is not the figure shown.
    expect(gpuProcessOwner('/usr/local/lib/ollama/llama-server', [{ ...ollama, source: 'engine' }])).toEqual({
      engine: 'ollama',
      inModelMemory: false,
    });
    expect(gpuProcessOwner('lemond', [])).toEqual({ engine: 'lemonade', inModelMemory: false });
  });

  it("calls a process no engine pattern matches unmanaged — fzzy's dflash_server", () => {
    expect(gpuProcessOwner('dflash_server', [{ backend: 'vllm', usedMb: 314, source: 'process' }])).toBe('unmanaged');
    expect(gpuProcessOwner('dflash_server', undefined)).toBe('unmanaged');
  });

  it('leaves a bare llama-server unnamed when it could be either engine, or when Model memory has not answered', () => {
    const lemonade = { backend: 'lemonade', usedMb: null, source: 'unmeasured' as const };

    expect(gpuProcessOwner('llama-server', [ollama, lemonade])).toBeNull();
    expect(gpuProcessOwner('llama-server', [])).toBeNull();
    expect(gpuProcessOwner('llama-server', undefined)).toBeNull();
  });

  it("does not count an engine the Hub could not ask as holding — its entry is the router's bookkeeping", () => {
    const lemonadeBookkept = { backend: 'lemonade', usedMb: 4_000, source: 'registry' as const };

    expect(gpuProcessOwner('llama-server', [ollama, lemonadeBookkept])).toEqual({ engine: 'ollama', inModelMemory: true });
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
