import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingConnectStore } from '../pending-connect.store';

/**
 * Unit tests for the in-memory state-nonce store — the login-CSRF / code-swap
 * guard for the cross-origin connect hop, and the tombstone that makes a
 * benign callback replay (browser refresh after an aborted navigation)
 * distinguishable from a forged or expired state.
 */
describe('PendingConnectStore', () => {
  it('round-trips: consume returns the app + next + userId bound to the created state', () => {
    const store = new PendingConnectStore();
    const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

    expect(store.consume(state)).toEqual({
      outcome: 'consumed',
      appUrn: 'ci-openclaw:local',
      next: 'https://app.example.com/',
      userId: 'user-1',
    });
  });

  it('reports later consumes of the same state as replays, with the same bound attempt', () => {
    const store = new PendingConnectStore();
    const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

    expect(store.consume(state).outcome).toBe('consumed');
    expect(store.consume(state)).toEqual({
      outcome: 'replayed',
      appUrn: 'ci-openclaw:local',
      next: 'https://app.example.com/',
      userId: 'user-1',
    });
    // Repeated refreshes within the tombstone window keep resolving.
    expect(store.consume(state).outcome).toBe('replayed');
  });

  it('returns unknown for a never-issued state', () => {
    const store = new PendingConnectStore();

    expect(store.consume('never-issued')).toEqual({ outcome: 'unknown' });
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

      expect(store.consume(state)).toEqual({ outcome: 'unknown' });
      expect(store.consume(state)).toEqual({ outcome: 'unknown' });
    });

    it('expires tombstones: replayed within the window, unknown after it', () => {
      const store = new PendingConnectStore();
      const state = store.create('ci-openclaw:local', 'https://app.example.com/', 'user-1');

      expect(store.consume(state).outcome).toBe('consumed');

      vi.advanceTimersByTime(60 * 1000);
      expect(store.consume(state).outcome).toBe('replayed');

      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(store.consume(state).outcome).toBe('unknown');
    });
  });

  it('bounds the tombstone map by evicting the oldest consumed state', () => {
    const store = new PendingConnectStore();
    const states: string[] = [];

    // One past MAX_TOMBSTONES (500) — the first consumed state is evicted.
    for (let i = 0; i < 501; i++) {
      const state = store.create('app:local', `/next-${i}`, 'user-1');
      states.push(state);
      expect(store.consume(state).outcome).toBe('consumed');
    }

    expect(store.consume(states[0] as string)).toEqual({ outcome: 'unknown' });
    expect(store.consume(states[500] as string).outcome).toBe('replayed');
  });
});
