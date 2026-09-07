import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPoolMessage,
  buildSignedPoolHeaders,
  generatePoolKeyPair,
  normalizePath,
  PeerNonceCache,
  PEER_NONCE_CACHE_MAX,
  PEER_SIGNATURE_SKEW_MS,
  POOL_NODE_HEADER,
  POOL_NONCE_HEADER,
  POOL_SIGNATURE_HEADER,
  POOL_SIGNATURE_PREFIX,
  POOL_TIMESTAMP_HEADER,
  poolRequestSignsBody,
  privateKeyFromBase64,
  publicKeyFingerprint,
  verifyPoolSignature,
  type PoolMessageParts,
} from '../hub-pool-peer-auth';

const SELF_UUID = '11111111-1111-4111-8111-111111111111';
const PEER_UUID = '22222222-2222-4222-8222-222222222222';
const CONTROL_PATH = '/api/inference/pool/pair/upgrade';
const FORWARD_PATH = '/api/inference/pool/local/v1/chat/completions';

const keys = generatePoolKeyPair();
const privateKey = privateKeyFromBase64(keys.privateKey);

function parts(overrides: Partial<PoolMessageParts> = {}): Omit<PoolMessageParts, 'timestampMs' | 'nonce'> {
  return {
    method: 'POST',
    path: CONTROL_PATH,
    senderNodeUuid: PEER_UUID,
    senderNodeFqdn: 'hub-b.example-tailnet.ts.net',
    recipientNodeUuid: SELF_UUID,
    body: { nodeUuid: PEER_UUID, publicKey: keys.publicKey },
    ...overrides,
  };
}

/** Sign, then hand the pieces back in the shape the verifier takes them. */
function signed(overrides: Partial<PoolMessageParts> = {}, now = Date.now()) {
  const built = buildSignedPoolHeaders(privateKey, parts(overrides), now);
  const source = parts(overrides);
  return {
    method: source.method,
    path: source.path,
    senderNodeUuid: source.senderNodeUuid,
    senderNodeFqdn: source.senderNodeFqdn,
    recipientNodeUuid: source.recipientNodeUuid,
    body: source.body,
    timestamp: built[POOL_TIMESTAMP_HEADER] as string,
    nonce: built[POOL_NONCE_HEADER] as string,
    signature: built[POOL_SIGNATURE_HEADER] as string,
    peerPublicKey: keys.publicKey,
    headers: built,
  };
}

describe('hub pool peer signing', () => {
  describe('the canonical message', () => {
    it('is byte-stable across key insertion order, which is what stops two Hubs disagreeing about the same body', () => {
      const a = buildPoolMessage({ ...parts({ body: { z: 1, a: { d: 4, c: 3 } } }), timestampMs: 1, nonce: 'n' });
      const b = buildPoolMessage({ ...parts({ body: { a: { c: 3, d: 4 }, z: 1 } }), timestampMs: 1, nonce: 'n' });

      expect(a).toBe(b);
    });

    it('treats a missing body and an empty one identically, so a GET signs the same on both sides', () => {
      const withUndefined = buildPoolMessage({ ...parts({ method: 'GET', body: undefined }), timestampMs: 1, nonce: 'n' });
      const withEmpty = buildPoolMessage({ ...parts({ method: 'GET', body: {} }), timestampMs: 1, nonce: 'n' });

      // Express hands the guard `{}` for a bodyless GET while the sender passes nothing at all.
      expect(withUndefined).toBe(withEmpty);
    });

    it('binds the body on control routes and deliberately does not on the forwarding path', () => {
      expect(poolRequestSignsBody(CONTROL_PATH)).toBe(true);
      expect(poolRequestSignsBody(FORWARD_PATH)).toBe(false);

      const one = buildPoolMessage({ ...parts({ path: FORWARD_PATH, body: { prompt: 'a' } }), timestampMs: 1, nonce: 'n' });
      const two = buildPoolMessage({ ...parts({ path: FORWARD_PATH, body: { prompt: 'b' } }), timestampMs: 1, nonce: 'n' });
      expect(one).toBe(two);
    });

    it('strips the query and any fragment, so the two sides cannot disagree about re-encoding', () => {
      expect(normalizePath('/api/inference/pool/capabilities?x=1#frag')).toBe('/api/inference/pool/capabilities');
      expect(normalizePath('')).toBe('/');
    });
  });

  describe('verification', () => {
    it('accepts a signature it produced', () => {
      expect(verifyPoolSignature(signed(), new PeerNonceCache())).toEqual({ ok: true });
    });

    it.each([
      ['method', { method: 'GET' }],
      ['path', { path: '/api/inference/pool/pair/confirm' }],
      ['sender uuid', { senderNodeUuid: randomUUID() }],
      ['sender fqdn', { senderNodeFqdn: 'hub-z.example-tailnet.ts.net' }],
      ['recipient uuid', { recipientNodeUuid: randomUUID() }],
      ['body', { body: { nodeUuid: PEER_UUID, publicKey: 'a-different-key' } }],
    ])('rejects a signature presented with a different %s', (_label, override) => {
      const original = signed();

      const result = verifyPoolSignature({ ...original, ...override }, new PeerNonceCache());

      expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects a signature made by a different key', () => {
      const other = generatePoolKeyPair();

      expect(verifyPoolSignature({ ...signed(), peerPublicKey: other.publicKey }, new PeerNonceCache())).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
    });

    it('accepts the skew window to its exact edge and rejects one millisecond past it', () => {
      const now = Date.now();

      expect(verifyPoolSignature(signed({}, now - PEER_SIGNATURE_SKEW_MS), new PeerNonceCache(), now)).toEqual({ ok: true });
      expect(verifyPoolSignature(signed({}, now + PEER_SIGNATURE_SKEW_MS), new PeerNonceCache(), now)).toEqual({ ok: true });
      expect(verifyPoolSignature(signed({}, now - PEER_SIGNATURE_SKEW_MS - 1), new PeerNonceCache(), now)).toEqual({
        ok: false,
        reason: 'expired',
      });
    });

    it.each([
      ['no timestamp', { timestamp: null }],
      ['no nonce', { nonce: null }],
      ['no signature', { signature: null }],
    ])('rejects a request with %s before doing any curve work', (_label, override) => {
      expect(verifyPoolSignature({ ...signed(), ...override }, new PeerNonceCache())).toEqual({ ok: false, reason: 'missing_headers' });
    });

    it('rejects a signature that is not the versioned form, and a non-integer timestamp', () => {
      expect(verifyPoolSignature({ ...signed(), signature: 'deadbeef' }, new PeerNonceCache())).toEqual({
        ok: false,
        reason: 'bad_signature_encoding',
      });
      expect(verifyPoolSignature({ ...signed(), timestamp: 'not-a-number' }, new PeerNonceCache())).toEqual({ ok: false, reason: 'bad_timestamp' });
    });

    it('rejects a replay of a signature it has already accepted', () => {
      const nonces = new PeerNonceCache();
      const request = signed();

      expect(verifyPoolSignature(request, nonces)).toEqual({ ok: true });
      expect(verifyPoolSignature(request, nonces)).toEqual({ ok: false, reason: 'replayed' });
    });

    it('keys the nonce per sender, so one peer cannot spend another peer’s nonce ahead of it', () => {
      const nonces = new PeerNonceCache();
      const request = signed();
      expect(verifyPoolSignature(request, nonces)).toEqual({ ok: true });

      // Same nonce string, different sender: a global keyspace would let a hostile peer burn a
      // legitimate one's nonce before its request arrived.
      const other = generatePoolKeyPair();
      const otherUuid = randomUUID();
      const otherHeaders = buildSignedPoolHeaders(privateKeyFromBase64(other.privateKey), parts({ senderNodeUuid: otherUuid }));
      expect(
        verifyPoolSignature(
          {
            ...signed({ senderNodeUuid: otherUuid }),
            timestamp: otherHeaders[POOL_TIMESTAMP_HEADER] as string,
            nonce: request.nonce,
            signature: otherHeaders[POOL_SIGNATURE_HEADER] as string,
            peerPublicKey: other.publicKey,
          },
          nonces,
        ).ok,
      ).toBe(false); // the signature is over its own nonce, not this one — but it is not a REPLAY
      expect(nonces.size()).toBe(2);
    });

    it('emits the headers under their documented names, with the versioned signature prefix', () => {
      const { headers } = signed();

      expect(headers[POOL_NODE_HEADER]).toBe(PEER_UUID);
      expect(headers[POOL_SIGNATURE_HEADER]).toMatch(new RegExp(`^${POOL_SIGNATURE_PREFIX.replace(/\./g, '\\.')}`));
      // The bearer credential must never ride along with a signature.
      expect(headers).not.toHaveProperty('Authorization');
    });
  });

  describe('the nonce cache', () => {
    it('drops expired entries before declaring itself full, so ordinary traffic never hits the ceiling', () => {
      const cache = new PeerNonceCache(2);
      const now = 1_000;

      expect(cache.remember('a', now + 10, now)).toBe('ok');
      expect(cache.remember('b', now + 10, now)).toBe('ok');
      // Both windows have closed by now, so the third insert reclaims rather than refusing.
      expect(cache.remember('c', now + 1_000, now + 100)).toBe('ok');
      expect(cache.size()).toBe(1);
    });

    it('fails CLOSED when it is genuinely full of live entries', () => {
      const cache = new PeerNonceCache(2);
      const now = 1_000;
      cache.remember('a', now + 10_000, now);
      cache.remember('b', now + 10_000, now);

      // Evicting a live nonce is exactly what re-opens the replay this cache exists to stop, so the
      // request is refused instead. The default ceiling is an order of magnitude above real traffic.
      expect(cache.remember('c', now + 10_000, now)).toBe('full');
      expect(PEER_NONCE_CACHE_MAX).toBeGreaterThan(1_000);
    });

    it('reports a full cache as its own reason, not as a bad signature', () => {
      const cache = new PeerNonceCache(0);

      expect(verifyPoolSignature(signed(), cache)).toEqual({ ok: false, reason: 'nonce_cache_full' });
    });
  });

  describe('fingerprints', () => {
    it('renders a stable colon-separated short hash of the key, never the key itself', () => {
      const fingerprint = publicKeyFingerprint(keys.publicKey);

      expect(fingerprint).toMatch(/^([0-9a-f]{2}:){7}[0-9a-f]{2}$/);
      expect(fingerprint).toBe(publicKeyFingerprint(keys.publicKey));
      expect(fingerprint).not.toBe(publicKeyFingerprint(generatePoolKeyPair().publicKey));
    });

    it('answers null for absent or unparseable material rather than throwing a status page over', () => {
      expect(publicKeyFingerprint(null)).toBeNull();
      expect(publicKeyFingerprint(undefined)).toBeNull();
      expect(publicKeyFingerprint('not-a-key')).toBeNull();
    });
  });
});
