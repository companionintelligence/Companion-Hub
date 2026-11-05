import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base58btcDecode, base58btcEncode, didKeyFromPublicKey, didKeyPublicBytes, didKeyPublicKey, isDidKey } from '../utils/did-key';

/**
 * Every constant below was produced by an INDEPENDENT encoder (a ten-line Python base58btc written
 * from the table, not from `did-key.ts`), so a bug shared by the code and its test cannot make them
 * agree. The same vectors are checked in Companion Memory's `didKeyId.spec.ts`. The `local.pub` row
 * is the public key Local.Pub publishes at `https://local.pub/.well-known/did.json`
 * (`did:web:local.pub#key-1`): a public key, not a secret.
 */
const VECTORS: Array<{ name: string; keyHex: string; did: string }> = [
  {
    name: 'RFC 8032 section 7.1, test 1',
    keyHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    did: 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw',
  },
  {
    name: 'did:key method specification example',
    keyHex: '2e6fcce36701dc791488e0d0b1745cc1e33a4c1c9fcc41c63bd343dbbe0970e6',
    did: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  },
  {
    // The key of the published CESR example recorded in FROZEN.md (`BGlOiUdp5sMmfotHfCWQKEzWR91C72AH0lT84c0um-Qj`): one key, two encodings.
    name: 'the KERI reference-vector key',
    keyHex: '694e894769e6c3267e8b477c2590284cd647dd42ef6007d254fce1cd2e9be423',
    did: 'did:key:z6MkmYLK2UFfWhxhZRkoD6Fq6aeWZXP4CQBkbLknM8syqH4v',
  },
  {
    name: 'local.pub did:web:local.pub#key-1',
    keyHex: 'b7e39ebf66bef1392c106cfa632bfecf4e5edbfe9060b9ed8f51955c04738233',
    did: 'did:key:z6Mkrq5xnGB7Q7ctdzzkFdubpm4Y2pQUEmN8peXGPh2Mf4TL',
  },
  {
    name: 'all-zero key (leading zero bytes after the multicodec)',
    keyHex: '00'.repeat(32),
    did: 'did:key:z6MkeTG3bFFSLYVU7VqhgZxqr6YzpaGrQtFMh1uvqGy1vDnP',
  },
  {
    name: 'all-0xff key',
    keyHex: 'ff'.repeat(32),
    did: 'did:key:z6MkwgaR63138bEEgad7uk993KMX54vBA6KTB4sFhCPnSB2e',
  },
];

describe('did:key codec', () => {
  describe.each(VECTORS)('$name', ({ keyHex, did }) => {
    it('encodes the key to the vector', () => {
      expect(didKeyFromPublicKey(Buffer.from(keyHex, 'hex'))).toBe(did);
    });

    it('decodes the vector back to the same key', () => {
      expect(Buffer.from(didKeyPublicBytes(did) as Uint8Array).toString('hex')).toBe(keyHex);
      expect(isDidKey(did)).toBe(true);
    });
  });

  it('round-trips freshly generated keys, and the derived verifying key verifies a signature', () => {
    for (let i = 0; i < 20; i += 1) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
      const did = didKeyFromPublicKey(Buffer.from(x, 'base64url')) as string;

      expect(did).toMatch(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);
      expect(Buffer.from(didKeyPublicBytes(did) as Uint8Array).toString('base64url')).toBe(x);

      const verifying = didKeyPublicKey(did);
      expect(verifying).not.toBeNull();
      const message = Buffer.from(`challenge-${i}`);
      expect(verify(null, message, verifying as never, sign(null, message, privateKey))).toBe(true);
    }
  });

  describe('refuses anything that is not one canonical Ed25519 did:key', () => {
    const valid = VECTORS[0].did;

    it.each([
      ['an empty string', ''],
      ['the wrong method', valid.replace('did:key:', 'did:web:')],
      ['a DID URL with the key as fragment', `${valid}#${valid.slice('did:key:'.length)}`],
      ['a query', `${valid}?versionId=1`],
      ['a path', `${valid}/x`],
      ['a missing multibase code', valid.replace('did:key:z', 'did:key:')],
      ['base58btc digits outside the alphabet (0, O, I, l)', valid.replace('6Mk', '0OIl')],
      ['a truncated key', valid.slice(0, -1)],
      ['a key with an extra character', `${valid}1`],
      ['uppercase method', valid.replace('did:key:', 'DID:KEY:')],
      ['surrounding whitespace', ` ${valid} `],
      ['an X25519 key (z6LS…, multicodec 0xec01)', 'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc'],
      ['a secp256k1 key (zQ3s…)', 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme'],
      ['a P-256 key (zDn…)', 'did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169'],
      ['a did:keri keyid', 'did:keri:D6Zwb8HfPqmyZXwMt1k0fKQPwoSTmN2GqmXdB2eyd1Mq'],
      ['did:webvh', 'did:webvh:QmSyntheticSyntheticSyntheticSyntheticSynth:alice.example'],
      ['did:scid:vh', 'did:scid:vh:1:QmSyntheticSyntheticSyntheticSyntheticSynth'],
    ])('%s', (_name, candidate) => {
      expect(isDidKey(candidate)).toBe(false);
      expect(didKeyPublicBytes(candidate)).toBeNull();
      expect(didKeyPublicKey(candidate)).toBeNull();
    });

    it('refuses a non-string without throwing', () => {
      for (const value of [undefined, null, 42, {}, []]) {
        expect(isDidKey(value)).toBe(false);
        expect(didKeyPublicKey(value)).toBeNull();
      }
    });
  });

  it('refuses a key of the wrong length', () => {
    expect(didKeyFromPublicKey(new Uint8Array(31))).toBeNull();
    expect(didKeyFromPublicKey(new Uint8Array(33))).toBeNull();
    expect(didKeyFromPublicKey(new Uint8Array(0))).toBeNull();
  });

  describe('base58btc', () => {
    it.each([
      ['', ''],
      ['00', '1'],
      ['0000', '11'],
      ['61', '2g'],
      ['626262', 'a3gV'],
      ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
    ])('encodes %s and decodes it back', (hex, text) => {
      const bytes = Buffer.from(hex, 'hex');

      expect(base58btcEncode(bytes)).toBe(text);
      expect(Buffer.from(base58btcDecode(text) as Uint8Array).toString('hex')).toBe(hex);
    });

    it('refuses a character outside the alphabet', () => {
      for (const char of ['0', 'O', 'I', 'l', '+']) {
        expect(base58btcDecode(char)).toBeNull();
      }
    });
  });
});
