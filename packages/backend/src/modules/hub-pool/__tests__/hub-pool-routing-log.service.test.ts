import { beforeEach, describe, expect, it } from 'vitest';
import { HubPoolRoutingLogService, ROUTING_LOG_CAPACITY, type PoolRoutingRecord } from '../hub-pool-routing-log.service';

function record(overrides: Partial<PoolRoutingRecord> = {}): PoolRoutingRecord {
  return {
    at: new Date().toISOString(),
    direction: 'outbound',
    path: '/v1/chat/completions',
    model: 'llama3.2:3b',
    node: 'local',
    peerId: null,
    backend: 'ollama',
    candidates: 1,
    attempt: 1,
    failedOverFrom: [],
    outcome: 'served',
    status: 200,
    durationMs: 12,
    ...overrides,
  };
}

describe('HubPoolRoutingLogService', () => {
  let service: HubPoolRoutingLogService;

  beforeEach(() => {
    service = new HubPoolRoutingLogService();
  });

  it('evicts the oldest entries once the buffer is full, and never grows past capacity', () => {
    for (let i = 0; i < ROUTING_LOG_CAPACITY + 50; i += 1) {
      service.record(record({ model: `model-${i}` }));
    }

    const entries = service.list();
    expect(entries).toHaveLength(ROUTING_LOG_CAPACITY);
    // Newest first, and the 50 oldest are gone rather than the newest being dropped.
    expect(entries[0]?.model).toBe(`model-${ROUTING_LOG_CAPACITY + 49}`);
    expect(entries.at(-1)?.model).toBe('model-50');
    expect(service.summary().recorded).toBe(ROUTING_LOG_CAPACITY);
  });

  it('returns the newest entries first so a UI page shows the most recent decisions', () => {
    service.record(record({ model: 'first' }));
    service.record(record({ model: 'second' }));
    service.record(record({ model: 'third' }));

    expect(service.list(2).map((e) => e.model)).toEqual(['third', 'second']);
  });

  it('counts a failover by the chain it carries, not by a separate entry per attempt', () => {
    service.record(record({ outcome: 'served' }));
    service.record(record({ outcome: 'served', failedOverFrom: ['local'], node: 'peer.example-tailnet.ts.net', attempt: 2 }));
    service.record(record({ outcome: 'failed', node: null, status: null, failedOverFrom: ['local', 'peer.example-tailnet.ts.net'] }));

    expect(service.summary()).toMatchObject({ recorded: 3, served: 2, failed: 1, failovers: 2, capacity: ROUTING_LOG_CAPACITY });
  });

  it('reports an empty buffer without a last timestamp', () => {
    expect(service.summary()).toMatchObject({ recorded: 0, served: 0, failed: 0, failovers: 0, lastAt: null });
    expect(service.list()).toEqual([]);
  });
});
