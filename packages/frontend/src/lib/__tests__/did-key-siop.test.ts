import { describe, expect, it } from 'vitest';
import { createSiopProofToken, encodeEd25519DidKey, generateBrowserDidKeyPair, isWebCryptoEd25519Supported } from '../did-key-siop';

function decodeBase64UrlJson<T>(segment: string): T {
  const padded = segment
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(segment.length / 4) * 4, '=');
  const decoded = Buffer.from(padded, 'base64').toString('utf8');
  return JSON.parse(decoded) as T;
}

describe('did-key-siop browser helper', () => {
  it('encodes known 32-byte Ed25519 public key bytes into canonical did:key:z6Mk form', () => {
    const did = encodeEd25519DidKey(new Uint8Array(32).fill(7));
    expect(did).toMatch(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);
  });

  it('rejects non-32-byte keys', () => {
    expect(() => encodeEd25519DidKey(new Uint8Array(16))).toThrow(/Expected 32-byte/);
  });

  it('generates an Ed25519 did:key pair and signs a valid SIOPv2 proof verifiable by WebCrypto', async () => {
    const supported = await isWebCryptoEd25519Supported();
    expect(supported).toBe(true);

    const keyPair = await generateBrowserDidKeyPair();
    expect(keyPair.did).toMatch(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);

    const token = await createSiopProofToken(keyPair, { nonce: 'nonce-123', audience: 'urn:ci-hub:test' }, 1_700_000_000);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);

    const [headerB64, payloadB64, sigB64] = parts;
    const header = decodeBase64UrlJson<{ alg: string; typ: string; kid: string }>(headerB64 ?? '');
    const payload = decodeBase64UrlJson<{ iss: string; sub: string; aud: string; nonce: string; iat: number; exp: number }>(payloadB64 ?? '');

    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: keyPair.did });
    expect(payload).toEqual({
      iss: keyPair.did,
      sub: keyPair.did,
      aud: 'urn:ci-hub:test',
      nonce: 'nonce-123',
      iat: 1_700_000_000,
      exp: 1_700_000_120,
    });

    const publicKey = await globalThis.crypto.subtle.importKey('jwk', keyPair.publicKeyJwk, { name: 'Ed25519' }, false, ['verify']);
    const sigBytes = Buffer.from((sigB64 ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const verified = await globalThis.crypto.subtle.verify('Ed25519', publicKey, sigBytes, new TextEncoder().encode(`${headerB64}.${payloadB64}`));
    expect(verified).toBe(true);
  });
});
