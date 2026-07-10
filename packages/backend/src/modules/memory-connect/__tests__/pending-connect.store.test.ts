import { describe, expect, it } from 'vitest';
import { PendingConnectStore } from '../pending-connect.store';

/**
 * Unit tests for the in-memory state-nonce store — the login-CSRF / code-swap
 * guard for the cross-origin connect hop.
 */
describe('PendingConnectStore', () => {
  it('round-trips: consume returns the app + next bound to the created state', () => {
    const store = new PendingConnectStore();
    const state = store.create('ci-openclaw:local', 'https://app.example.com/');

    expect(store.consume(state)).toEqual({ appUrn: 'ci-openclaw:local', next: 'https://app.example.com/' });
  });

  it('is single-use: a second consume of the same state returns null', () => {
    const store = new PendingConnectStore();
    const state = store.create('ci-openclaw:local', 'https://app.example.com/');

    expect(store.consume(state)).not.toBeNull();
    expect(store.consume(state)).toBeNull();
  });

  it('returns null for an unknown state', () => {
    const store = new PendingConnectStore();

    expect(store.consume('never-issued')).toBeNull();
  });

  it('issues distinct, high-entropy state nonces', () => {
    const store = new PendingConnectStore();
    const a = store.create('app-a:local', '/a');
    const b = store.create('app-b:local', '/b');

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
