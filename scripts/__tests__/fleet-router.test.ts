import { describe, expect, it } from 'vitest';
import { type FleetNode, formatDiscovery, inferenceNodes, rankCandidates } from '../fleet-router';

// Importing the module at all proves the CLI entry is guarded — an unguarded `main()` in the module
// body would fire a full tailnet probe (and `process.exit`) before any assertion ran.

function node(overrides: Partial<FleetNode> & { name: string }): FleetNode {
  return {
    ip: '100.64.0.1',
    os: 'linux',
    online: true,
    isSelf: false,
    models: [],
    running: 0,
    loadKnown: true,
    hubReachable: false,
    poolCapable: false,
    ...overrides,
  };
}

describe('rankCandidates', () => {
  it('only offers nodes that actually hold the model', () => {
    const nodes = [node({ name: 'has', models: ['qwen3:8b'] }), node({ name: 'lacks', models: ['gemma3:1b'] })];
    expect(rankCandidates(nodes, 'qwen3:8b').map((r) => r.node.name)).toEqual(['has']);
  });

  it('ranks a busy local node BELOW an idle peer — the case pooling exists for', () => {
    // Without a single ranked list this is the bug the Hub's own comment calls out: a local backend
    // that merely *has* the model would always sort first and work could never route away.
    const nodes = [node({ name: 'self', isSelf: true, models: ['m'], running: 5 }), node({ name: 'peer', models: ['m'], running: 0 })];
    expect(rankCandidates(nodes, 'm').map((r) => r.node.name)).toEqual(['peer', 'self']);
  });

  it('keeps work local when the peer is only as empty as the affinity head start', () => {
    // local 1 vs peer 0 + affinity 1 = 1 — a tie, and a tie keeps insertion order, which puts self first.
    const nodes = [node({ name: 'self', isSelf: true, models: ['m'], running: 1 }), node({ name: 'peer', models: ['m'], running: 0 })];
    expect(rankCandidates(nodes, 'm')[0]?.node.name).toBe('self');
  });

  it('hands off once the peer is emptier than the head start', () => {
    const nodes = [node({ name: 'self', isSelf: true, models: ['m'], running: 2 }), node({ name: 'peer', models: ['m'], running: 0 })];
    expect(rankCandidates(nodes, 'm')[0]?.node.name).toBe('peer');
  });

  it('never treats an unmeasured node as idle', () => {
    // A node whose load probe failed must rank as mid-load, not as the emptiest machine in the fleet.
    const measured = node({ name: 'measured', models: ['m'], running: 0, loadKnown: true });
    const unmeasured = node({ name: 'unmeasured', models: ['m'], running: 0, loadKnown: false });
    expect(rankCandidates([unmeasured, measured], 'm').map((r) => r.node.name)).toEqual(['measured', 'unmeasured']);
  });

  it('returns nothing when no node holds the model, rather than guessing', () => {
    expect(rankCandidates([node({ name: 'a', models: ['x'] })], 'y')).toEqual([]);
  });
});

describe('inferenceNodes', () => {
  it('excludes tailnet devices with no engine, including Hubs that only answer the API', () => {
    const nodes = [node({ name: 'engine', models: ['m'] }), node({ name: 'hub-only', hubReachable: true }), node({ name: 'phone' })];
    expect(inferenceNodes(nodes).map((n) => n.name)).toEqual(['engine']);
  });
});

describe('formatDiscovery', () => {
  const nodes = [
    node({ name: 'self', isSelf: true, models: ['gemma3:1b'], running: 1 }),
    node({ name: 'pooled', models: ['qwen3:8b'], hubReachable: true, poolCapable: true }),
    node({ name: 'hub-only', hubReachable: true }),
    node({ name: 'offline-phone', online: false }),
  ];

  it('counts engines and pool-capable Hubs separately', () => {
    const out = formatDiscovery(nodes).join('\n');
    expect(out).toContain('Inference nodes        : 2');
    expect(out).toContain('Hub API reachable      : 2  (pool-capable: 1)');
  });

  it('marks the local node so a routing decision can be read against it', () => {
    expect(formatDiscovery(nodes).join('\n')).toContain('self (self)');
  });

  it('lists a Hub with no engine separately instead of dropping it', () => {
    const out = formatDiscovery(nodes).join('\n');
    expect(out).toContain('Hub API but no local inference engine:');
    expect(out).toContain('hub-only');
  });

  it('shows an unmeasured load as ? rather than as zero', () => {
    const out = formatDiscovery([node({ name: 'n', models: ['m'], loadKnown: false })]).join('\n');
    expect(out).toMatch(/n\s+100\.64\.0\.1\s+\?/);
  });
});
