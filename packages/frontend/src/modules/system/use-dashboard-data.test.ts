import { describe, expect, it } from 'vitest';
import {
  countedInModelMemory,
  estimatedPromptTokens,
  gpuProcessOwner,
  hostRamUsedMb,
  isUnplaced,
  loadState,
  peerLabel,
  poolModelIndex,
  type PoolNodeSummary,
  type PoolPeerSummary,
  poolReach,
  routingLogKeys,
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

  it('counts a disabled peer as disabled whatever its socket says, as the node cards and the reach drawing do', () => {
    // One definition for the rail, the verdict and the drawing's legend: an operator disable outranks
    // the lifecycle status, exactly as `connected` already excludes a disabled peer.
    const reach = poolReach([withModels('parked', ['a:1b'], { status: 'unreachable', enabled: false })], local);

    expect(reach).toMatchObject({ connected: 0, unreachable: 0 });
  });

  it('counts failed probes only on peers still in use', () => {
    const reach = poolReach(
      [
        withModels('parked', ['a:1b'], { status: 'unreachable', enabled: false, consecutiveFailures: 18966 }),
        withModels('flaky', ['a:1b'], { consecutiveFailures: 1 }),
        withModels('steady', ['a:1b'], { consecutiveFailures: 0 }),
      ],
      local,
    );

    expect(reach.probeFailures).toBe(1);
  });

  it("sums this Hub's forwarded counter over every peer that reports it, so it equals the drawing's badges", () => {
    // Our own counter about work we sent there: still ours to read after the peer dropped or was disabled.
    const reach = poolReach(
      [
        withModels('busy', ['a:1b'], { inFlightRequests: 2 }),
        withModels('dropped', ['a:1b'], { status: 'unreachable', inFlightRequests: 1 }),
        withModels('parked', ['a:1b'], { enabled: false, inFlightRequests: 1 }),
      ],
      local,
    );

    expect(reach.peerInFlight).toBe(4);
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

describe('isUnplaced', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({ at: '2026-01-01T00:00:00Z', direction: 'outbound', node: null, outcome: 'failed', failedOverFrom: [], ...over }) as never;

  it('calls a request unplaced only when there was no candidate to ask', () => {
    expect(isUnplaced(row({ candidates: 0 }))).toBe(true);
    expect(isUnplaced(row({ candidates: 9, failedOverFrom: ['a'] }))).toBe(false);
  });

  it('never calls an inbound row unplaced — its node is the sender', () => {
    expect(isUnplaced(row({ direction: 'inbound', candidates: 0 }))).toBe(false);
  });

  it('falls back on a Hub too old to report candidates: a row that failed over was placed', () => {
    expect(isUnplaced(row())).toBe(true);
    expect(isUnplaced(row({ failedOverFrom: ['a'] }))).toBe(false);
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
/*
 * The backend's own rule (`memory-manager.service.ts`), applied to the rows the container sampler
 * could not give to a workload. Each case is one the backend decides the same way, so the GPU tile
 * and Model memory can never disagree about whose memory a process holds.
 */
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
});

/*
 * The backend's rule (`memory-manager.service.ts`), applied to the GPU rows the container sampler
 * could not give to an app, so the GPU card never lists an engine's runner as outside every app
 * beside the models that runner holds.
 */
describe('gpuProcessOwner', () => {
  const ollama = { backend: 'ollama', pool: 'ram' as const, usedMb: 24_824, source: 'process' as const };

  it("gives core-2's bare llama-server to Ollama, the only llama.cpp engine holding a model, and counts it", () => {
    expect(gpuProcessOwner('llama-server', [ollama])).toEqual({ engine: 'ollama', inModelMemory: true });
    expect(countedInModelMemory(gpuProcessOwner('llama-server', [ollama]))).toBe(true);
  });

  it('names an engine by its process, and counts it only when model memory was sized from it', () => {
    expect(gpuProcessOwner('VLLM::EngineCor', [{ backend: 'vllm', usedMb: 314, source: 'process' }])).toEqual({
      engine: 'vllm',
      inModelMemory: true,
    });
    expect(gpuProcessOwner('/usr/local/lib/ollama/llama-server', [{ ...ollama, source: 'engine' }])).toEqual({
      engine: 'ollama',
      inModelMemory: false,
    });
    expect(gpuProcessOwner('lemond', [])).toEqual({ engine: 'lemonade', inModelMemory: false });
  });

  it("calls a process no engine pattern matches unmanaged, as fzzy's dflash_server is", () => {
    expect(gpuProcessOwner('dflash_server', [{ backend: 'vllm', usedMb: 314, source: 'process' }])).toBe('unmanaged');
    expect(countedInModelMemory('unmanaged')).toBe(false);
  });

  it('leaves a bare llama-server unnamed when it could be either engine, or when model memory has not answered', () => {
    const lemonade = { backend: 'lemonade', usedMb: null, source: 'unmeasured' as const };

    expect(gpuProcessOwner('llama-server', [ollama, lemonade])).toBeNull();
    expect(gpuProcessOwner('llama-server', undefined)).toBeNull();
    expect(countedInModelMemory(null)).toBe(false);
  });

  it("does not count an engine the Hub could not ask as holding: its entry is the router's bookkeeping", () => {
    expect(gpuProcessOwner('llama-server', [ollama, { backend: 'lemonade', usedMb: 4_000, source: 'registry' as const }])).toEqual({
      engine: 'ollama',
      inModelMemory: true,
    });
  });
});
