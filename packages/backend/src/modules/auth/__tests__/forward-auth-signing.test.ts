import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FORWARD_AUTH_SIGNATURE_HEADER,
  FORWARD_AUTH_TIMESTAMP_HEADER,
  FORWARD_AUTH_USER_HEADER,
  FORWARD_AUTH_USER_ID_HEADER,
  FORWARD_AUTH_USER_ID_SIGNATURE_HEADER,
  FORWARD_AUTH_USER_ISSUER_HEADER,
  buildForwardAuthMessage,
  buildForwardAuthUserIdMessage,
  buildSignedForwardAuthHeaders,
  signForwardAuthUser,
  signForwardAuthUserId,
  verifyForwardAuthHeaders,
} from '../utils/forward-auth-signing';

const SECRET = 'test-shared-secret';

describe('forward-auth-signing', () => {
  it('produces a deterministic HMAC-SHA256 signature over username + timestamp', () => {
    const ts = 1_700_000_000_000;
    const expected = crypto.createHmac('sha256', SECRET).update(`alice\n${ts}`).digest('hex');

    expect(signForwardAuthUser(SECRET, 'alice', ts)).toBe(expected);
    expect(buildForwardAuthMessage('alice', ts)).toBe(`alice\n${ts}`);
  });

  it('builds the full signed header set with a fixed clock', () => {
    const now = 1_700_000_000_000;
    const headers = buildSignedForwardAuthHeaders(SECRET, 'bob', now);

    expect(headers[FORWARD_AUTH_USER_HEADER]).toBe('bob');
    expect(headers[FORWARD_AUTH_TIMESTAMP_HEADER]).toBe(String(now));
    expect(headers[FORWARD_AUTH_SIGNATURE_HEADER]).toBe(signForwardAuthUser(SECRET, 'bob', now));
  });

  it('yields a different signature for a different username (no cross-user reuse)', () => {
    const now = 1_700_000_000_000;
    const alice = buildSignedForwardAuthHeaders(SECRET, 'alice', now);
    const mallory = buildSignedForwardAuthHeaders(SECRET, 'mallory', now);

    expect(alice[FORWARD_AUTH_SIGNATURE_HEADER]).not.toBe(mallory[FORWARD_AUTH_SIGNATURE_HEADER]);
  });

  it('a forger without the shared secret cannot reproduce the signature', () => {
    const now = 1_700_000_000_000;
    const legit = signForwardAuthUser(SECRET, 'alice', now);
    const forged = signForwardAuthUser('guessed-secret', 'alice', now);

    expect(forged).not.toBe(legit);
  });

  it('throws when no secret is provided', () => {
    expect(() => buildSignedForwardAuthHeaders('', 'alice', 1)).toThrow(/shared secret/);
  });
});

const ISSUER = 'urn:ci-hub:6f1c2a4e-2f3b-4c5d-8e9f-0a1b2c3d4e5f';
const PUBLIC_ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';

describe('forward-auth-signing: the stable id', () => {
  const now = 1_700_000_000_000;

  it('signs the id over the issuer, id, username and timestamp, with a versioned prefix', () => {
    const message = `ci-hub-user-id/1\n${ISSUER}\n${PUBLIC_ID}\nalice\n${now}`;

    expect(buildForwardAuthUserIdMessage(ISSUER, PUBLIC_ID, 'alice', now)).toBe(message);
    expect(signForwardAuthUserId(SECRET, ISSUER, PUBLIC_ID, 'alice', now)).toBe(crypto.createHmac('sha256', SECRET).update(message).digest('hex'));
  });

  it('adds the issuer, id and id signature beside the unchanged triple', () => {
    const headers = buildSignedForwardAuthHeaders(SECRET, 'alice', now, { issuer: ISSUER, userId: PUBLIC_ID });
    const legacy = buildSignedForwardAuthHeaders(SECRET, 'alice', now);

    // An app that only knows the triple verifies exactly what it always did.
    expect(headers[FORWARD_AUTH_SIGNATURE_HEADER]).toBe(legacy[FORWARD_AUTH_SIGNATURE_HEADER]);
    expect(headers[FORWARD_AUTH_USER_ISSUER_HEADER]).toBe(ISSUER);
    expect(headers[FORWARD_AUTH_USER_ID_HEADER]).toBe(PUBLIC_ID);
    expect(headers[FORWARD_AUTH_USER_ID_SIGNATURE_HEADER]).toBe(signForwardAuthUserId(SECRET, ISSUER, PUBLIC_ID, 'alice', now));
  });

  it('signs the username alone when no stable id is known', () => {
    const headers = buildSignedForwardAuthHeaders(SECRET, 'alice', now, null);

    expect(Object.keys(headers).sort()).toEqual([FORWARD_AUTH_SIGNATURE_HEADER, FORWARD_AUTH_USER_HEADER, FORWARD_AUTH_TIMESTAMP_HEADER].sort());
  });

  it('round-trips through the verifier, which mirrors CI-Server', () => {
    const headers = buildSignedForwardAuthHeaders(SECRET, 'alice', now, { issuer: ISSUER, userId: PUBLIC_ID });
    const result = verifyForwardAuthHeaders(
      SECRET,
      {
        user: headers[FORWARD_AUTH_USER_HEADER],
        timestamp: headers[FORWARD_AUTH_TIMESTAMP_HEADER],
        signature: headers[FORWARD_AUTH_SIGNATURE_HEADER],
        issuer: headers[FORWARD_AUTH_USER_ISSUER_HEADER],
        userId: headers[FORWARD_AUTH_USER_ID_HEADER],
        userIdSignature: headers[FORWARD_AUTH_USER_ID_SIGNATURE_HEADER],
      },
      { now },
    );

    expect(result).toEqual({ ok: true, username: 'alice', stableId: { issuer: ISSUER, userId: PUBLIC_ID } });
  });

  it('rejects an id carried onto another person, and an id with no signature', () => {
    const alice = buildSignedForwardAuthHeaders(SECRET, 'alice', now, { issuer: ISSUER, userId: PUBLIC_ID });
    const bob = buildSignedForwardAuthHeaders(SECRET, 'bob', now);
    const spliced = {
      user: 'bob',
      timestamp: bob[FORWARD_AUTH_TIMESTAMP_HEADER],
      signature: bob[FORWARD_AUTH_SIGNATURE_HEADER],
      issuer: ISSUER,
      userId: PUBLIC_ID,
      userIdSignature: alice[FORWARD_AUTH_USER_ID_SIGNATURE_HEADER],
    };

    expect(verifyForwardAuthHeaders(SECRET, spliced, { now })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyForwardAuthHeaders(SECRET, { ...spliced, userIdSignature: null }, { now })).toEqual({ ok: false, reason: 'bad_stable_id' });
  });
});
