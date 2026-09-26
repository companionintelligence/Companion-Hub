import { describe, expect, it } from 'vitest';
import {
  QUEUE_MESSAGE_ENVELOPE_KEY,
  QueueNonceCache,
  canonicalJson,
  deriveQueueSigningKey,
  signQueueMessage,
  verifyQueueMessage,
} from '../message-signing';

const KEY = deriveQueueSigningKey('hub-jwt-secret');
const QUEUE = 'app-events-queue';
const T0 = 1_700_000_000_000;

function fresh() {
  return { nonces: new QueueNonceCache(), now: T0 };
}

describe('queue message signing', () => {
  it('derives a key that does not reveal JWT_SECRET and differs per secret', () => {
    expect(KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(KEY).not.toContain('hub-jwt-secret');
    expect(deriveQueueSigningKey('other')).not.toBe(KEY);
    expect(() => deriveQueueSigningKey('')).toThrow();
  });

  it('round-trips: a signed message verifies and yields the bare payload', () => {
    const payload = { appUrn: 'ci-memory:ci-marketplace', command: 'restart', requestId: 'r1', form: { a: 1 } };
    const wire = signQueueMessage(KEY, QUEUE, payload, T0);

    expect(wire).toMatchObject(payload);
    expect(wire[QUEUE_MESSAGE_ENVELOPE_KEY]).toMatchObject({ v: 1, ts: T0 });

    const result = verifyQueueMessage(KEY, QUEUE, wire, fresh());
    expect(result).toEqual({ ok: true, payload });
  });

  it('does not depend on property order', () => {
    const wire = signQueueMessage(KEY, QUEUE, { b: { y: 2, x: 1 }, a: [1, { d: 4, c: 3 }] }, T0);
    const reordered = { a: wire.a, b: { x: 1, y: 2 }, [QUEUE_MESSAGE_ENVELOPE_KEY]: wire[QUEUE_MESSAGE_ENVELOPE_KEY] };

    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(verifyQueueMessage(KEY, QUEUE, reordered, fresh()).ok).toBe(true);
  });

  it('rejects an unsigned body — what any pre-existing client or an attacker with the broker password sends', () => {
    expect(verifyQueueMessage(KEY, QUEUE, { command: 'uninstall', appUrn: 'x' }, fresh())).toEqual({ ok: false, reason: 'missing_envelope' });
    expect(verifyQueueMessage(KEY, QUEUE, null, fresh())).toEqual({ ok: false, reason: 'missing_envelope' });
    expect(verifyQueueMessage(KEY, QUEUE, 'string', fresh())).toEqual({ ok: false, reason: 'missing_envelope' });
  });

  it('rejects a tampered payload, a wrong key, and a message signed for another queue', () => {
    const wire = signQueueMessage(KEY, QUEUE, { command: 'restart', appUrn: 'a' }, T0);

    expect(verifyQueueMessage(KEY, QUEUE, { ...wire, command: 'uninstall' }, fresh())).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyQueueMessage(deriveQueueSigningKey('other'), QUEUE, wire, fresh())).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyQueueMessage(KEY, 'other-queue', wire, fresh())).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a malformed envelope', () => {
    const wire = signQueueMessage(KEY, QUEUE, { command: 'restart' }, T0);
    const broken = { ...wire, [QUEUE_MESSAGE_ENVELOPE_KEY]: { ...wire[QUEUE_MESSAGE_ENVELOPE_KEY], v: 2 } };

    expect(verifyQueueMessage(KEY, QUEUE, broken, fresh())).toEqual({ ok: false, reason: 'bad_envelope' });
  });

  it('rejects a message outside the skew window in either direction', () => {
    const wire = signQueueMessage(KEY, QUEUE, { command: 'restart' }, T0);

    expect(verifyQueueMessage(KEY, QUEUE, wire, { nonces: new QueueNonceCache(), now: T0 + 11 * 60_000 })).toEqual({ ok: false, reason: 'expired' });
    expect(verifyQueueMessage(KEY, QUEUE, wire, { nonces: new QueueNonceCache(), now: T0 - 11 * 60_000 })).toEqual({ ok: false, reason: 'expired' });
    expect(verifyQueueMessage(KEY, QUEUE, wire, { nonces: new QueueNonceCache(), now: T0 + 9 * 60_000 }).ok).toBe(true);
  });

  it('rejects a replay of a message it already accepted, but a failed message does not poison the nonce cache', () => {
    const nonces = new QueueNonceCache();
    const wire = signQueueMessage(KEY, QUEUE, { command: 'restart' }, T0);

    // A forged message reusing the legitimate nonce is refused on signature
    // BEFORE the nonce is recorded, so the real message still gets through.
    const forged = { ...wire, command: 'uninstall' };
    expect(verifyQueueMessage(KEY, QUEUE, forged, { nonces, now: T0 })).toEqual({ ok: false, reason: 'bad_signature' });

    expect(verifyQueueMessage(KEY, QUEUE, wire, { nonces, now: T0 }).ok).toBe(true);
    expect(verifyQueueMessage(KEY, QUEUE, wire, { nonces, now: T0 + 1000 })).toEqual({ ok: false, reason: 'replayed' });
  });

  it('forgets nonces after their window and stays bounded', () => {
    const nonces = new QueueNonceCache(1000, 2);

    expect(nonces.record('a', 0)).toBe(true);
    expect(nonces.record('a', 10)).toBe(false);
    expect(nonces.record('b', 10)).toBe(true);
    // Third entry evicts the oldest rather than growing without bound.
    expect(nonces.record('c', 20)).toBe(true);
    expect(nonces.record('a', 30)).toBe(true);
    // Expired entries are forgotten.
    expect(nonces.record('b', 5000)).toBe(true);
  });
});
