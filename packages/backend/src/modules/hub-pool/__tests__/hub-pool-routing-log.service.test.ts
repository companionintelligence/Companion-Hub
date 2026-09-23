import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HubPoolRoutingLogService,
  MAX_ROUTING_LOG_CAPACITY,
  ROUTING_LOG_CAPACITY,
  resolveRoutingLogCapacity,
  type PoolRoutingRecordInput,
} from '../hub-pool-routing-log.service';

function record(overrides: Partial<PoolRoutingRecordInput> = {}): PoolRoutingRecordInput {
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
    pin: null,
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

      expect(service.summary()).toMatchObject({ served: 0, failed: 1, pending: 0, clientClosed: 0 });
    });

    /**
     * A caller that leaves is not a routing failure, and the summary is where an operator forms
     * their first impression of the pool: `22 served · 4 failed` on beta-max (2026-09-21) was read
     * as the pool being unable to place a quarter of its work, when all four were callers that had
     * given up on a turn a node was still prefilling. Kept INSIDE `failed` — the request really did
     * go unanswered — and reported beside it, so the two readings are both available.
     */
    it('counts a row the caller abandoned inside failed, and separately', () => {
      const row = service.open((({ outcome: _o, status: _s, durationMs: _d, ...rest }) => rest)(record()));

      service.settle(row, { outcome: 'failed', status: null, clientClosed: true, durationMs: 30_031 });

      expect(service.summary()).toMatchObject({ served: 0, failed: 1, clientClosed: 1, pending: 0 });
      // The node placement wrote is exactly what `settle` must not have dropped: it is the whole
      // difference between this row and the one above, both in the CLI and on the dashboard.
      expect(service.list()[0]).toMatchObject({ node: 'local', backend: 'ollama', clientClosed: true });
    });

    it('defaults the flag to false, so a row nothing set it on never reads as an abandoned request', () => {
      service.record(record());

      expect(service.list()[0]?.clientClosed).toBe(false);
      expect(service.summary().clientClosed).toBe(0);
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

  /**
   * Fleet QA attributed an agent turn's calls to rows by time window on the entry Hub's clock, which
   * cannot separate two concurrent calls for one model. The id is the join key instead, so it has to
   * be unique per row and survive every mutation the proxy makes to a row it already handed out.
   */
  describe('request ids', () => {
    it('mints a distinct id for every row', () => {
      const ids = new Set(Array.from({ length: 50 }, () => service.record(record()).id));

      expect(ids.size).toBe(50);
    });

    it('keeps the id a peer sent, so the inbound row joins the sender outbound row', () => {
      const row = service.record(record({ direction: 'inbound', id: 'req-from-core' }));

      expect(row.id).toBe('req-from-core');
    });

    it('keeps the same id through failover, settle and usage', () => {
      const { outcome: _o, status: _s, durationMs: _d, usage: _u, ...placement } = record();
      const row = service.open(placement);
      const id = row.id;

      service.update(row, { node: 'core-14.tail.ts.net', attempt: 2 });
      service.settle(row, { outcome: 'served', status: 200, durationMs: 10 });
      service.attachUsage(row, { promptTokens: 1, completionTokens: 1, totalTokens: 2 });

      expect(service.list()[0]?.id).toBe(id);
    });

    it('defaults the request-shape fields to null where the caller had no body to describe', () => {
      expect(service.record(record())).toMatchObject({ stream: null, bodyBytes: null, budgetMs: null });
    });
  });

  /**
   * The 200-row ring overflowed in a burst between two polls and nothing said so. A cursor on the time
   * a row last changed lets a poller take only what is new — and see the settle of a row it last saw
   * pending, which a cursor on placement time would never return.
   */
  describe('since cursor', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function openAt(iso: string, model: string) {
      vi.setSystemTime(new Date(iso));
      const { outcome: _o, status: _s, durationMs: _d, usage: _u, ...placement } = record({ model, at: iso });
      return service.open(placement);
    }

    it('returns rows changed at or after the cursor, and the cursor to use next', () => {
      vi.useFakeTimers();
      const early = openAt('2026-09-17T10:00:00.000Z', 'early');
      openAt('2026-09-17T10:00:05.000Z', 'late');

      vi.setSystemTime(new Date('2026-09-17T10:04:00.000Z'));
      service.settle(early, { outcome: 'served', status: 200, durationMs: 240_000 });

      const page = service.query({ since: '2026-09-17T10:00:05.000Z' });

      // Inclusive: `late` changed exactly at the cursor. `early` was placed before it but settled after.
      expect(page.entries.map((entry) => entry.model)).toEqual(['late', 'early']);
      expect(page.matched).toBe(2);
      expect(page.nextSince).toBe('2026-09-17T10:04:00.000Z');
    });

    it('compares instants, so a cursor written with a zone offset selects the same rows', () => {
      vi.useFakeTimers();
      openAt('2026-09-17T10:00:00.000Z', 'before');
      openAt('2026-09-17T10:30:00.000Z', 'after');

      expect(service.query({ since: '2026-09-17T12:15:00+02:00' }).entries.map((entry) => entry.model)).toEqual(['after']);
    });

    /**
     * The failure this pins: the page kept the newest placements but `nextSince` was the newest change
     * of everything matched, so a poller following the documented loop through a burst bigger than its
     * `limit` skipped every row the cut dropped — silently, since `matched` was the only sign.
     */
    it('pages a burst bigger than limit without losing a row, following nextSince alone', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 7; i += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 8, 17, 10, 0, i)));
        service.record(record({ model: `m${i}` }));
      }

      const first = service.query({ since: '2026-09-17T10:00:00.000Z', limit: 3 });
      expect(first.matched).toBe(7);
      // The oldest changes, newest first — the rest wait for the cursor.
      expect(first.entries.map((entry) => entry.model)).toEqual(['m2', 'm1', 'm0']);

      const seen = new Set<string>();
      let since = '2026-09-17T10:00:00.000Z';
      for (let polls = 0; polls < 10; polls += 1) {
        const page = service.query({ since, limit: 3 });
        for (const entry of page.entries) seen.add(entry.model ?? '');
        if (page.nextSince === null || page.nextSince === since) break;
        since = page.nextSince;
      }

      expect([...seen].sort()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    });

    it('still returns the newest placements without a cursor, with a cursor that tails from the newest change', () => {
      vi.useFakeTimers();
      for (let i = 0; i < 5; i += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 8, 17, 10, 0, i)));
        service.record(record({ model: `m${i}` }));
      }

      const page = service.query({ limit: 2 });

      expect(page.entries.map((entry) => entry.model)).toEqual(['m4', 'm3']);
      expect(page.matched).toBe(5);
      expect(page.nextSince).toBe('2026-09-17T10:00:04.000Z');
    });

    it('takes a row that settled after later rows were placed on the page where its change falls', () => {
      vi.useFakeTimers();
      const slow = openAt('2026-09-17T10:00:00.000Z', 'slow');
      openAt('2026-09-17T10:00:01.000Z', 'quick-1');
      openAt('2026-09-17T10:00:02.000Z', 'quick-2');
      vi.setSystemTime(new Date('2026-09-17T10:05:00.000Z'));
      service.settle(slow, { outcome: 'served', status: 200, durationMs: 300_000 });

      const first = service.query({ since: '2026-09-17T10:00:00.000Z', limit: 2 });
      expect(first.entries.map((entry) => entry.model)).toEqual(['quick-2', 'quick-1']);
      expect(first.nextSince).toBe('2026-09-17T10:00:02.000Z');

      const second = service.query({ since: first.nextSince ?? '', limit: 2 });
      expect(second.entries.map((entry) => entry.model)).toEqual(['quick-2', 'slow']);
      expect(second.entries[1]).toMatchObject({ outcome: 'served' });
    });
  });

  describe('restart and eviction signals', () => {
    it('gives each process its own bootId, so a poller can tell a restart from a quiet pool', () => {
      const other = new HubPoolRoutingLogService();

      expect(service.summary().bootId).toMatch(/^[0-9a-f-]{36}$/);
      expect(other.summary().bootId).not.toBe(service.summary().bootId);
      expect(Date.parse(service.summary().startedAt)).not.toBeNaN();
    });

    it('counts rows recorded since boot beyond what the ring still holds, and dates the oldest survivor', () => {
      for (let i = 0; i < ROUTING_LOG_CAPACITY + 7; i += 1) {
        service.record(record({ model: `model-${i}`, at: new Date(Date.UTC(2026, 8, 17, 0, 0, i)).toISOString() }));
      }

      const summary = service.summary();
      expect(summary.totalRecorded - summary.recorded).toBe(7);
      expect(summary.oldestAt).toBe(new Date(Date.UTC(2026, 8, 17, 0, 0, 7)).toISOString());
    });
  });

  describe('HUB_POOL_ROUTING_LOG_SIZE', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      ['unset', undefined, ROUTING_LOG_CAPACITY],
      ['not a number', 'lots', ROUTING_LOG_CAPACITY],
      ['below the default, which would stop the dashboard caveat from ever firing', '50', ROUTING_LOG_CAPACITY],
      ['a fraction', '2500.9', 2500],
      ['above the ceiling', '1000000', MAX_ROUTING_LOG_CAPACITY],
    ])('resolves %s to a bounded ring', (_label, raw, expected) => {
      expect(resolveRoutingLogCapacity(raw)).toBe(expected);
    });

    it('holds the configured ring, but still serves the default page to a caller that names no limit', () => {
      vi.stubEnv('HUB_POOL_ROUTING_LOG_SIZE', '500');
      const large = new HubPoolRoutingLogService();
      for (let i = 0; i < 600; i += 1) large.record(record({ model: `m${i}` }));

      expect(large.summary()).toMatchObject({ capacity: 500, recorded: 500 });
      // The dashboard polls without a limit every 15 s; a raised ring must not raise that payload.
      expect(large.list()).toHaveLength(ROUTING_LOG_CAPACITY);
      expect(large.query({ limit: 500 }).entries).toHaveLength(500);
    });
  });
});
