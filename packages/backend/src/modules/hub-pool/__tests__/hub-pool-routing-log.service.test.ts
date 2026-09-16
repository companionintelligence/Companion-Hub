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
    usage: null,
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
    expect(service.summary()).toMatchObject({ recorded: 0, served: 0, failed: 0, pending: 0, failovers: 0, lastAt: null });
    expect(service.list()).toEqual([]);
  });

  // A request placed on a self-hosted engine can wait minutes for its first byte. Until the row
  // existed at placement the operator saw nothing for that whole wait.
  describe('a row opened at placement', () => {
    it('is listed as pending with no duration, and counts as neither served nor failed', () => {
      const { outcome: _o, status: _s, durationMs: _d, ...placement } = record({ node: 'core-2.tail.ts.net' });
      const row = service.open(placement);

      expect(service.list()[0]).toBe(row);
      expect(row).toMatchObject({ outcome: 'pending', status: null, durationMs: null, node: 'core-2.tail.ts.net' });
      expect(service.summary()).toMatchObject({ recorded: 1, served: 0, failed: 0, pending: 1 });
    });

    it('settles in place — the same single row, updated, never a second entry', () => {
      const { outcome: _o, status: _s, durationMs: _d, ...placement } = record();
      const row = service.open(placement);
      row.failedOverFrom.push('local');

      service.settle(row, { node: 'core-2.tail.ts.net', outcome: 'served', status: 200, durationMs: 131_800 });

      expect(service.list()).toHaveLength(1);
      expect(service.list()[0]).toMatchObject({
        outcome: 'served',
        status: 200,
        durationMs: 131_800,
        node: 'core-2.tail.ts.net',
        failedOverFrom: ['local'],
      });
      expect(service.summary()).toMatchObject({ served: 1, failed: 0, pending: 0, failovers: 1 });
    });

    it('settles as failed without a node when every candidate was tried', () => {
      const row = service.open((({ outcome: _o, status: _s, durationMs: _d, ...rest }) => rest)(record()));

      service.settle(row, { node: null, outcome: 'failed', durationMs: 900_000 });

      expect(service.summary()).toMatchObject({ served: 0, failed: 1, pending: 0 });
    });

    it('opens with no usage, and settling at headers time does not invent one', () => {
      const { outcome: _o, status: _s, durationMs: _d, ...placement } = record();
      const row = service.open(placement);

      expect(row.usage).toBeNull();

      service.settle(row, { outcome: 'served', status: 200, durationMs: 50 });

      expect(row.usage).toBeNull();
    });

    it('attachUsage records tokens on the same row after settle, without disturbing the outcome', () => {
      const { outcome: _o, status: _s, durationMs: _d, ...placement } = record();
      const row = service.open(placement);
      service.settle(row, { outcome: 'served', status: 200, durationMs: 50 });

      service.attachUsage(row, { promptTokens: 120, completionTokens: 30, totalTokens: 150 });

      expect(service.list()[0]).toMatchObject({
        outcome: 'served',
        status: 200,
        usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
      });
    });
  });
});
