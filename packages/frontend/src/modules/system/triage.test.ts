import { describe, expect, it } from 'vitest';

import { pageVerdict, type VerdictInput } from './triage';

/*
 * The page verdict's whole job is to refuse to overclaim, so these tests are about what it
 * declines to say rather than about what it says.
 *
 * `t` is the identity on the key, so a fault's copy can change without touching this file while
 * its identity — which is what the page keys and tones off — stays asserted.
 */
const ok = { pending: false, failed: false };
const failed = { pending: false, failed: true };
const pending = { pending: true, failed: false };

function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    containers: { state: ok, degraded: 0 },
    pool: { state: ok, unreachablePeers: 0, probeFailures: 0, stalePins: 0, envDisabledDirections: 0, capabilitiesError: false },
    routing: { state: ok, unplaced: 0 },
    otherStates: [ok, ok],
    t: (key) => key,
    ...overrides,
  };
}

describe('pageVerdict', () => {
  it('is clear only when every check ran and every check passed', () => {
    expect(pageVerdict(input())).toEqual({ kind: 'clear', faults: [], unavailable: 0 });
  });

  it('never claims clear while a check is still in flight', () => {
    expect(pageVerdict(input({ otherStates: [ok, pending] })).kind).toBe('pending');
  });

  it('reports partial when a query failed and nothing measured is wrong', () => {
    const verdict = pageVerdict(input({ otherStates: [failed, ok] }));

    expect(verdict.kind).toBe('partial');
    expect(verdict.unavailable).toBe(1);
    expect(verdict.faults).toEqual([]);
  });

  it('never returns clear while any check is unavailable, even with nothing else outstanding', () => {
    for (const overrides of [
      { containers: { state: failed, degraded: 0 } },
      { pool: { state: failed, unreachablePeers: 0, probeFailures: 0, stalePins: 0, envDisabledDirections: 0, capabilitiesError: false } },
      { routing: { state: failed, unplaced: 0 } },
      { otherStates: [failed] },
    ] satisfies Partial<VerdictInput>[]) {
      expect(pageVerdict(input(overrides)).kind).not.toBe('clear');
    }
  });

  it('counts every failed query, not just the first', () => {
    const verdict = pageVerdict(
      input({ containers: { state: failed, degraded: 0 }, routing: { state: failed, unplaced: 0 }, otherStates: [failed, ok] }),
    );

    expect(verdict.unavailable).toBe(3);
    expect(verdict.kind).toBe('partial');
  });

  it('does not turn a failed query into a fault, whatever counts came with it', () => {
    // The stale counts are what a caller would be holding from the last successful poll. A
    // failed fetch must produce "we could not check", never "we checked and it is broken".
    const verdict = pageVerdict(
      input({
        containers: { state: failed, degraded: 3 },
        pool: { state: failed, unreachablePeers: 2, probeFailures: 1, stalePins: 1, envDisabledDirections: 1, capabilitiesError: true },
        routing: { state: failed, unplaced: 5 },
      }),
    );

    expect(verdict.faults).toEqual([]);
    expect(verdict.kind).toBe('partial');
    expect(verdict.unavailable).toBe(3);
  });

  it('raises measured faults from the queries that did answer', () => {
    const verdict = pageVerdict(
      input({
        containers: { state: ok, degraded: 2 },
        pool: { state: ok, unreachablePeers: 1, probeFailures: 3, stalePins: 1, envDisabledDirections: 1, capabilitiesError: true },
        routing: { state: ok, unplaced: 4 },
      }),
    );

    expect(verdict.kind).toBe('faults');
    expect(verdict.faults.map((fault) => fault.id)).toEqual([
      'workloads-degraded',
      'peers-unreachable',
      'probe-failures',
      'stale-pins',
      'env-disabled',
      'capabilities-error',
      'unplaced',
    ]);
    expect(verdict.faults.filter((fault) => fault.tone === 'bad').map((fault) => fault.id)).toEqual([
      'workloads-degraded',
      'peers-unreachable',
      'unplaced',
    ]);
  });

  it('keeps reporting faults and unavailable checks side by side rather than hiding one behind the other', () => {
    const verdict = pageVerdict(input({ containers: { state: ok, degraded: 1 }, otherStates: [failed, failed] }));

    expect(verdict.kind).toBe('faults');
    expect(verdict.unavailable).toBe(2);
  });

  it('interpolates the measured count into a fault label', () => {
    const verdict = pageVerdict(input({ containers: { state: ok, degraded: 2 }, t: (key, vars) => `${key}:${vars?.count}` }));

    expect(verdict.faults[0]?.label).toBe('DASHBOARD_VERDICT_DEGRADED:2');
  });
});
