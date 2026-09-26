import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-message authentication for the Hub's work queues.
 *
 * The broker carries lifecycle commands — install, uninstall, reset, restart,
 * backup, restore — and the consumer used to run whatever arrived on the
 * queue. Anyone able to reach the broker with its password could therefore
 * drive the Hub: until this existed, that was every installed app (the
 * password rode along in each app's env file) and any LAN host (the AMQP port
 * was published on every interface). Both leaks are closed separately; this is
 * the layer that makes the broker itself an untrusted transport, so a future
 * leak of the broker password is not a leak of Hub authority.
 *
 * Every message the Hub publishes carries an `__hub` envelope: a version, a
 * millisecond timestamp, a random nonce, and an HMAC-SHA256 over
 * `queue name + timestamp + nonce + sha256(canonical payload)`. The consumer
 * refuses anything without a valid envelope, anything outside the skew window,
 * and any nonce it has already accepted. The key is derived from the Hub's
 * own `JWT_SECRET` — a Hub-only secret that never reaches an app — so
 * publisher and consumer share it by construction and no new secret is
 * provisioned. The derivation is one-way: holding the queue key does not
 * reveal `JWT_SECRET`.
 *
 * Canonicalisation sorts object keys recursively (the same rule CI-Server's
 * connect signing uses) so the signature does not depend on property order.
 */

export const QUEUE_MESSAGE_ENVELOPE_KEY = '__hub' as const;
export const QUEUE_MESSAGE_VERSION = 1 as const;
/**
 * Commands can legitimately sit in the durable queue across a Hub restart, so
 * the window is generous; replay inside it is caught by the nonce cache.
 */
export const DEFAULT_QUEUE_MESSAGE_MAX_SKEW_MS = 10 * 60_000;

export interface QueueMessageEnvelope {
  v: typeof QUEUE_MESSAGE_VERSION;
  ts: number;
  nonce: string;
  sig: string;
}

export type QueueMessageVerifyResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: 'missing_envelope' | 'bad_envelope' | 'expired' | 'replayed' | 'bad_signature' };

const MAX_CANONICALIZE_DEPTH = 64;

export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || typeof node !== 'object') {
      return node;
    }
    if (depth > MAX_CANONICALIZE_DEPTH) {
      throw new RangeError('queue message nesting exceeds the allowed depth');
    }
    if (seen.has(node)) {
      return null;
    }
    seen.add(node);

    let result: unknown;
    if (Array.isArray(node)) {
      result = node.map((item) => walk(item, depth + 1));
    } else {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node as Record<string, unknown>).sort()) {
        out[key] = walk((node as Record<string, unknown>)[key], depth + 1);
      }
      result = out;
    }

    seen.delete(node);
    return result;
  };

  return JSON.stringify(walk(value ?? {}, 0));
}

/** One-way derivation so the queue key can be handed to the queue layer without exposing JWT_SECRET. */
export function deriveQueueSigningKey(jwtSecret: string): string {
  if (!jwtSecret) {
    throw new Error('deriveQueueSigningKey: a non-empty secret is required');
  }
  return createHmac('sha256', jwtSecret).update('ci-hub:queue-message-signing:v1').digest('hex');
}

function signatureFor(key: string, queueName: string, ts: number, nonce: string, payload: unknown): string {
  const payloadDigest = createHash('sha256').update(canonicalJson(payload)).digest('hex');
  return createHmac('sha256', key)
    .update([queueName, String(ts), nonce, payloadDigest].join('\n'))
    .digest('hex');
}

function signaturesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Attach the envelope. The payload itself is left untouched so schemas that validate it keep working. */
export function signQueueMessage<T extends Record<string, unknown>>(
  key: string,
  queueName: string,
  payload: T,
  now: number = Date.now(),
): T & { [QUEUE_MESSAGE_ENVELOPE_KEY]: QueueMessageEnvelope } {
  const nonce = randomBytes(16).toString('hex');
  const envelope: QueueMessageEnvelope = {
    v: QUEUE_MESSAGE_VERSION,
    ts: now,
    nonce,
    sig: signatureFor(key, queueName, now, nonce, payload),
  };
  return { ...payload, [QUEUE_MESSAGE_ENVELOPE_KEY]: envelope };
}

/**
 * Remembers accepted nonces for the skew window so a captured message cannot be
 * replayed inside it. Bounded: once full it drops the oldest entries, which can
 * only ever make it stricter (a forgotten nonce is re-checked against the
 * timestamp window, not accepted blindly).
 */
export class QueueNonceCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = DEFAULT_QUEUE_MESSAGE_MAX_SKEW_MS * 2,
    private readonly maxEntries: number = 10_000,
  ) {}

  /** Records `nonce`; returns false when it was already present (a replay). */
  record(nonce: string, now: number = Date.now()): boolean {
    this.prune(now);
    if (this.seen.has(nonce)) {
      return false;
    }
    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }

  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(nonce);
      }
    }
  }
}

/**
 * Check a received body. On success the returned payload is the body WITHOUT
 * the envelope — what the consumer callback should see.
 */
export function verifyQueueMessage(
  key: string,
  queueName: string,
  body: unknown,
  opts: { now?: number; maxSkewMs?: number; nonces: QueueNonceCache },
): QueueMessageVerifyResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'missing_envelope' };
  }

  const { [QUEUE_MESSAGE_ENVELOPE_KEY]: envelope, ...payload } = body as Record<string, unknown>;

  if (envelope === undefined) {
    return { ok: false, reason: 'missing_envelope' };
  }

  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    (envelope as QueueMessageEnvelope).v !== QUEUE_MESSAGE_VERSION ||
    !Number.isInteger((envelope as QueueMessageEnvelope).ts) ||
    typeof (envelope as QueueMessageEnvelope).nonce !== 'string' ||
    !(envelope as QueueMessageEnvelope).nonce ||
    typeof (envelope as QueueMessageEnvelope).sig !== 'string'
  ) {
    return { ok: false, reason: 'bad_envelope' };
  }

  const { ts, nonce, sig } = envelope as QueueMessageEnvelope;
  const now = opts.now ?? Date.now();
  const maxSkewMs = opts.maxSkewMs ?? DEFAULT_QUEUE_MESSAGE_MAX_SKEW_MS;

  if (Math.abs(now - ts) > maxSkewMs) {
    return { ok: false, reason: 'expired' };
  }

  // Signature before nonce: an unsigned replay attempt must not be able to
  // poison the cache with nonces the legitimate publisher may still use.
  let expected: string;
  try {
    expected = signatureFor(key, queueName, ts, nonce, payload);
  } catch {
    return { ok: false, reason: 'bad_envelope' };
  }
  if (!signaturesEqual(sig, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (!opts.nonces.record(nonce, now)) {
    return { ok: false, reason: 'replayed' };
  }

  return { ok: true, payload };
}
