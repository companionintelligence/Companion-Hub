import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BearerOrgMembershipCache } from '../bearer-org-membership.cache';

describe('BearerOrgMembershipCache', () => {
  let cache: BearerOrgMembershipCache;

  beforeEach(() => {
    vi.useRealTimers();
    cache = new BearerOrgMembershipCache();
  });

  it('returns undefined for a subject it has never seen', () => {
    expect(cache.get('nobody')).toBeUndefined();
  });

  it('remembers both a grant and a refusal', () => {
    cache.set('yes', true);
    cache.set('no', false);

    expect(cache.get('yes')).toBe(true);
    // Distinct from `undefined`: a remembered refusal is what stops a retrying client hammering Portal.
    expect(cache.get('no')).toBe(false);
  });

  it('forgets a verdict once its TTL has passed', () => {
    vi.useFakeTimers();
    cache.set('subject', true);
    expect(cache.get('subject')).toBe(true);

    vi.advanceTimersByTime(60_001);

    expect(cache.get('subject')).toBeUndefined();
  });

  it('measures the TTL from when the verdict arrives, not from when the lookup began', async () => {
    // A Portal call can take its full 10s timeout. A TTL started before it would arrive already
    // part-spent, and a slow enough lookup would write an entry that is expired on arrival.
    vi.useFakeTimers();
    const start = Date.now();
    vi.advanceTimersByTime(59_000);
    cache.set('slow', true);

    // 59s after the notional start, but only 1s after the verdict: still live.
    vi.setSystemTime(start + 59_000 + 59_000);
    expect(cache.get('slow')).toBe(true);
  });

  it('coalesces concurrent lookups for one subject into a single call', async () => {
    let release: (value: 'member') => void = () => undefined;
    const lookup = vi.fn(() => new Promise<'member'>((resolve) => (release = resolve)));

    const inFlight = [cache.coalesce('s', lookup), cache.coalesce('s', lookup), cache.coalesce('s', lookup)];
    release('member');
    const results = await Promise.all(inFlight);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['member', 'member', 'member']);
  });

  it('does not coalesce across different subjects', async () => {
    const lookup = vi.fn(async () => 'member' as const);

    await Promise.all([cache.coalesce('a', lookup), cache.coalesce('b', lookup)]);

    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('releases the in-flight slot when a lookup rejects, so the next request retries', async () => {
    const failing = vi.fn(async () => {
      throw new Error('portal down');
    });
    await expect(cache.coalesce('s', failing)).rejects.toThrow('portal down');

    const succeeding = vi.fn(async () => 'member' as const);
    await expect(cache.coalesce('s', succeeding)).resolves.toBe('member');
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it('stays bounded when handed a stream of distinct subjects', () => {
    for (let i = 0; i < 1500; i++) {
      cache.set(`subject-${i}`, true);
    }

    // Reaching in on purpose: the bound is the point of the test, and it has no public reader.
    const size = (cache as unknown as { verdicts: Map<string, unknown> }).verdicts.size;
    expect(size).toBeLessThanOrEqual(1000);
    // The most recent write always survives eviction.
    expect(cache.get('subject-1499')).toBe(true);
  });

  it('drops every verdict on clear, so factory reset revokes cached authority', () => {
    cache.set('allowed', true);
    cache.set('refused', false);

    cache.clear();

    expect(cache.get('allowed')).toBeUndefined();
    expect(cache.get('refused')).toBeUndefined();
  });
});
