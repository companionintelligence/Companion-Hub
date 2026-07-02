import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FORWARD_AUTH_SIGNATURE_HEADER,
  FORWARD_AUTH_TIMESTAMP_HEADER,
  FORWARD_AUTH_USER_HEADER,
  buildForwardAuthMessage,
  buildSignedForwardAuthHeaders,
  signForwardAuthUser,
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
