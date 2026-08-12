import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingConnectStore } from '../pending-connect.store';

/**
 * Unit tests for the in-memory state-nonce store — the login-CSRF / code-swap
 * guard for the cross-origin connect hop. A state is bound to its initiating
 * user (anyone else is `foreign` and consumes nothing); a consumed state
 * leaves a tombstone recording the presented code hash and the resolved
 * redirect, so a same-code replay repeats the real outcome while a fresh code
 * (the user granted consent again) re-opens the attempt.
 */
describe('PendingConnectStore', () => {
  it('round-trips: consume returns the attempt bound to the created state', () => {
    const store = new PendingConnectStore();
    const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

    expect(store.consume(state, 'user-1', 'hash-a')).toEqual({
      outcome: 'consumed',
      appUrn: 'ci-openclaw:local',
      next: 'https://app.example.com/',
      userId: 'user-1',
      redirect: 'https://app.example.com/',
    });
  });

  it('reports a same-code replay with the redirect defaulting to next (safe until an outcome is recorded)', () => {
    const store = new PendingConnectStore();
    const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

    expect(store.consume(state, 'user-1', 'hash-a').outcome).toBe('consumed');
    expect(store.consume(state, 'user-1', 'hash-a')).toEqual({
      outcome: 'replayed',
      appUrn: 'ci-openclaw:local',
      next: 'https://app.example.com/',
      userId: 'user-1',
      redirect: 'https://app.example.com/',
    });
    // Repeated refreshes within the tombstone window keep resolving.
    expect(store.consume(state, 'user-1', 'hash-a').outcome).toBe('replayed');
  });

  it('replays the recorded outcome once one is set', () => {
    const store = new PendingConnectStore();
    const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

    store.consume(state, 'user-1', 'hash-a');
    store.recordOutcome(state, '/memory-connect/finishing?app=ci-openclaw%3Alocal');

    const replay = store.consume(state, 'user-1', 'hash-a');

    expect(replay.outcome).toBe('replayed');
    expect(replay.outcome === 'replayed' && replay.redirect).toBe('/memory-connect/finishing?app=ci-openclaw%3Alocal');
  });

  it('re-opens a consumed state for a DIFFERENT code — a fresh consent grant is not a replay', () => {
    // Deny → back → Allow, or Allow again after a failed exchange: CI-Server
    // issues a fresh single-use code with the same state; swallowing it as a
    // replay would silently drop a real user approval.
    const store = new PendingConnectStore();
    const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

    store.consume(state, 'user-1'); // deny path presents no code
    store.recordOutcome(state, '/somewhere-else');

    const fresh = store.consume(state, 'user-1', 'hash-new');

    expect(fresh).toEqual({
      outcome: 'consumed',
      appUrn: 'ci-openclaw:local',
      next: 'https://app.example.com/',
      userId: 'user-1',
      redirect: 'https://app.example.com/', // redirect reset to the safe default
    });
    // The fresh code is now the recorded one — replaying IT is a replay again.
    expect(store.consume(state, 'user-1', 'hash-new').outcome).toBe('replayed');
  });

  it('reports foreign for another user WITHOUT consuming — the initiator can still complete the flow', () => {
    const store = new PendingConnectStore();
    const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

    expect(store.consume(state, 'user-2', 'hash-x')).toEqual({ outcome: 'foreign' });
    // The pending entry survived the foreign hit.
    expect(store.consume(state, 'user-1', 'hash-a').outcome).toBe('consumed');
    // Tombstones are user-bound too.
    expect(store.consume(state, 'user-2', 'hash-a')).toEqual({ outcome: 'foreign' });
  });

  it('fails closed on an empty user id', () => {
    const store = new PendingConnectStore();
    const state = store.create('ci-openclaw:local', 'https://app.example.com/', '');

    expect(store.consume(state, '')).toEqual({ outcome: 'foreign' });
  });

  it('returns unknown for a never-issued or missing state', () => {
    const store = new PendingConnectStore();

    expect(store.consume('never-issued', 'user-1')).toEqual({ outcome: 'unknown' });
    expect(store.consume(undefined, 'user-1')).toEqual({ outcome: 'unknown' });
  });

  it('recordOutcome on an unknown or never-consumed state is a no-op', () => {
    const store = new PendingConnectStore();
    const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

    // Not consumed yet — no tombstone to update; the pending entry is untouched.
    store.recordOutcome(state, '/somewhere');
    store.recordOutcome('never-issued', '/somewhere');

    expect(store.consume(state, 'user-1', 'hash-a').outcome).toBe('consumed');
  });

  it('issues distinct, high-entropy state nonces', () => {
    const store = new PendingConnectStore();
    const a = store.create('app-a:local', '/a', 'user-1');
    const b = store.create('app-b:local', '/b', 'user-1');

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('treats an expired pending state as unknown and never tombstones it', () => {
      const store = new PendingConnectStore();
      const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

      // Past the 10-minute pending TTL: the flow never completed, so a late
      // callback must read as invalid — not as a replay of a success.
      vi.advanceTimersByTime(11 * 60 * 1000);

      expect(store.consume(state, 'user-1', 'hash-a')).toEqual({ outcome: 'unknown' });
      expect(store.consume(state, 'user-1', 'hash-a')).toEqual({ outcome: 'unknown' });
    });

    it('does not slide the tombstone TTL on re-arm — the ceiling is absolute from the first consume', () => {
      const store = new PendingConnectStore();
      const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

      // First consume at T0 — tombstone expires at T0 + 10 min.
      expect(store.consume(state, 'user-1', 'hash-a').outcome).toBe('consumed');

      // A fresh consent grant 9 minutes in re-opens the attempt, but must NOT push
      // the expiry forward: a leaked state cannot be kept re-armable indefinitely.
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(store.consume(state, 'user-1', 'hash-b').outcome).toBe('consumed');

      // 2 minutes later (T0 + 11 min) the original ceiling has passed.
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(store.consume(state, 'user-1', 'hash-b')).toEqual({ outcome: 'unknown' });
    });

    it('expires tombstones: replayed within the 10-minute window, unknown after it', () => {
      const store = new PendingConnectStore();
      const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

      expect(store.consume(state, 'user-1', 'hash-a').outcome).toBe('consumed');

      // Well past the interstitial's own 3-minute restart budget — a stale-tab
      // refresh during a slow restart must still resolve.
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(store.consume(state, 'user-1', 'hash-a').outcome).toBe('replayed');

      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(store.consume(state, 'user-1', 'hash-a').outcome).toBe('unknown');
    });
  });

  it('bounds the tombstone map by evicting the oldest consumed state', () => {
    const store = new PendingConnectStore();
    const states: string[] = [];

    // One past MAX_TOMBSTONES (500) — the first consumed state is evicted.
    for (let i = 0; i < 501; i++) {
      const state = store.create('app:local', `/next-${i}`, 'user-1');
      states.push(state);
      expect(store.consume(state, 'user-1', `hash-${i}`).outcome).toBe('consumed');
    }

    expect(store.consume(states[0] as string, 'user-1', 'hash-0')).toEqual({ outcome: 'unknown' });
    expect(store.consume(states[500] as string, 'user-1', 'hash-500').outcome).toBe('replayed');
  });
});
