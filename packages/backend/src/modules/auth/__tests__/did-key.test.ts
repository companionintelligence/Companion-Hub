import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base58btcDecode,
  base58btcEncode,
  didKeyFromPublicKey,
  didKeyPublicBytes,
  didKeyPublicKey,
  isDidKey,
  isWeakEd25519Key,
} from '../utils/did-key';

/**
 * Every constant below was produced by an INDEPENDENT encoder (a ten-line Python base58btc and the
 * RFC 8032 formulas on Python integers, written from the tables, not from `did-key.ts`), so a bug
 * shared by the code and its test cannot make them agree. The same vectors are checked in Companion
 * Memory's `didKeyId.spec.ts`. The `local.pub` row is the key in the service's own
 * `https://local.pub/.well-known/did.json` (`did:web:local.pub#key-1`): a public key, not a secret,
 * and not an account's key. It is a vector for the codec and says nothing about who signs in.
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
    name: 'the service key at did:web:local.pub#key-1 (not an account key)',
    keyHex: 'b7e39ebf66bef1392c106cfa632bfecf4e5edbfe9060b9ed8f51955c04738233',
    did: 'did:key:z6Mkrq5xnGB7Q7ctdzzkFdubpm4Y2pQUEmN8peXGPh2Mf4TL',
  },
];

/**
 * The 14 encodings of the eight torsion points (orders 1, 2, 4 and 8, each in both signs, and the
 * non-canonical `y + p` spellings of the identity and of the order-4 point), plus the largest 255-bit
 * `y`. Each was derived in Python from p = 2^255 - 19 and libsodium's order-8 value; the Python
 * script also decoded each canonical one under RFC 8032 and found its order by repeated addition.
 */
const WEAK_ENCODINGS: Array<{ name: string; keyHex: string }> = [
  { name: 'order 1 (identity, y = 1)', keyHex: '01'.padEnd(64, '0') },
  { name: 'order 1, sign bit set', keyHex: `${'01'.padEnd(62, '0')}80` },
  { name: 'order 1, non-canonical y = p + 1', keyHex: `ee${'ff'.repeat(30)}7f` },
  { name: 'order 1, non-canonical y = p + 1, sign bit set', keyHex: `ee${'ff'.repeat(31)}` },
  { name: 'order 2 (y = p - 1)', keyHex: `ec${'ff'.repeat(30)}7f` },
  { name: 'order 2, sign bit set', keyHex: `ec${'ff'.repeat(31)}` },
  { name: 'order 4 (y = 0), the all-zero key', keyHex: '00'.repeat(32) },
  { name: 'order 4, sign bit set', keyHex: `${'00'.repeat(31)}80` },
  { name: 'order 4, non-canonical y = p', keyHex: `ed${'ff'.repeat(30)}7f` },
  { name: 'order 4, non-canonical y = p, sign bit set', keyHex: `ed${'ff'.repeat(31)}` },
  { name: 'order 8 (y8)', keyHex: '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05' },
  { name: 'order 8 (y8), sign bit set', keyHex: '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85' },
  { name: 'order 8 (p - y8)', keyHex: 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a' },
  { name: 'order 8 (p - y8), sign bit set', keyHex: 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa' },
  { name: 'the all-0xff key (y = 2^255 - 1 = p + 18, sign bit set)', keyHex: 'ff'.repeat(32) },
  { name: 'y = 2^255 - 1 = p + 18, sign bit clear', keyHex: `${'ff'.repeat(31)}7f` },
];

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

/** The spelling of any 32 bytes as a did:key, with no check: what an attacker would publish. */
const spell = (keyHex: string) => `did:key:z${base58btcEncode(Uint8Array.from([0xed, 0x01, ...bytes(keyHex)]))}`;

describe('did:key codec', () => {
  describe.each(VECTORS)('$name', ({ keyHex, did }) => {
    it('encodes the key to the vector', () => {
      expect(didKeyFromPublicKey(bytes(keyHex))).toBe(did);
      expect(spell(keyHex)).toBe(did);
    });

    it('decodes the vector back to the same key', () => {
      expect(Buffer.from(didKeyPublicBytes(did) as Uint8Array).toString('hex')).toBe(keyHex);
      expect(isDidKey(did)).toBe(true);
    });

    it('is not a weak key', () => {
      expect(isWeakEd25519Key(bytes(keyHex))).toBe(false);
    });
  });

  it('round-trips freshly generated keys, none is weak, and the derived verifying key verifies a signature', () => {
    for (let i = 0; i < 200; i += 1) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
      const raw = Buffer.from(x, 'base64url');

      expect(isWeakEd25519Key(raw)).toBe(false);
      const did = didKeyFromPublicKey(raw) as string;
      expect(did).toMatch(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);
      expect(Buffer.from(didKeyPublicBytes(did) as Uint8Array).toString('base64url')).toBe(x);

      if (i < 20) {
        const verifying = didKeyPublicKey(did);
        expect(verifying).not.toBeNull();
        const message = Buffer.from(`challenge-${i}`);
        expect(verify(null, message, verifying as never, sign(null, message, privateKey))).toBe(true);
      }
    }
  });

  describe('refuses a weak key: a point of order 1, 2, 4 or 8, or a non-canonical y', () => {
    it.each(WEAK_ENCODINGS)('$name', ({ keyHex }) => {
      const did = spell(keyHex);

      // The DID is well formed in every other way: it has the right shape, length and multicodec.
      expect(did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]{47}$/);
      expect(isWeakEd25519Key(bytes(keyHex))).toBe(true);
      expect(isDidKey(did)).toBe(false);
      expect(didKeyPublicBytes(did)).toBeNull();
      expect(didKeyPublicKey(did)).toBeNull();
      // And this code never mints one.
      expect(didKeyFromPublicKey(bytes(keyHex))).toBeNull();
    });

    it('is exactly the y values y >= p and the five torsion values: the boundaries on both sides', () => {
      // p - 2 and p - 18 are ordinary y values just below the prime (and just below p - 1, the order-2 point).
      expect(isWeakEd25519Key(bytes(`eb${'ff'.repeat(30)}7f`))).toBe(false);
      expect(isWeakEd25519Key(bytes(`db${'ff'.repeat(30)}7f`))).toBe(false);
      // 2 is an ordinary y just above the identity.
      expect(isWeakEd25519Key(bytes('02'.padEnd(64, '0')))).toBe(false);
      // y8 +- 1 are not torsion values.
      expect(isWeakEd25519Key(bytes('25e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'))).toBe(false);
      expect(isWeakEd25519Key(bytes('27e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'))).toBe(false);
      // p - 1 is refused (order 2) and p - 1 with the low byte changed is not.
      expect(isWeakEd25519Key(bytes(`ec${'ff'.repeat(30)}7f`))).toBe(true);
      expect(isWeakEd25519Key(bytes(`ea${'ff'.repeat(30)}7f`))).toBe(false);
    });

    it('is the 8-torsion subgroup of the curve, recomputed here with BigInt, not taken from the constants', () => {
      const p = (1n << 255n) - 19n;
      const d = (((p - 121665n) % p) * modPow(121666n, p - 2n, p)) % p;
      const add = ([x1, y1]: [bigint, bigint], [x2, y2]: [bigint, bigint]): [bigint, bigint] => {
        const t = (d * x1 * x2 * y1 * y2) % p;
        return [((x1 * y2 + x2 * y1) * modPow(1n + t, p - 2n, p)) % p, ((y1 * y2 + x1 * x2) * modPow(1n - t + p, p - 2n, p)) % p];
      };
      const identity: [bigint, bigint] = [0n, 1n];
      const orderOf = (point: [bigint, bigint]) => {
        let acc = identity;
        for (let k = 1; k <= 8; k += 1) {
          acc = add(acc, point);
          if (acc[0] === identity[0] && acc[1] === identity[1]) return k;
        }
        return 0;
      };

      // Decode the order-8 value libsodium lists and check, from the group law alone, that it has order 8.
      const y8 = leInt('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05');
      const x8 = recoverX(y8, 0n, p, d);
      expect(orderOf([x8, y8])).toBe(8);
      expect(leInt('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a')).toBe(p - y8);

      // Every multiple of an order-8 point is a torsion point; collect their y values.
      const ys = new Set<bigint>();
      let acc = identity;
      for (let k = 0; k < 8; k += 1) {
        ys.add(acc[1]);
        acc = add(acc, [x8, y8]);
      }

      expect(ys).toEqual(new Set([0n, 1n, p - 1n, y8, p - y8]));
      // The curve's cofactor is 8, so those eight points are the whole torsion subgroup: no other y qualifies.
      for (const y of ys) {
        expect(isWeakEd25519Key(Uint8Array.from(Buffer.from(y.toString(16).padStart(64, '0'), 'hex').reverse()))).toBe(true);
      }
    });
  });

  describe('refuses anything that is not one canonical Ed25519 did:key', () => {
    const valid = (VECTORS[0] as (typeof VECTORS)[number]).did;

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

    it('refuses a value of the right shape whose multicodec is not Ed25519: the check after the pattern', () => {
      // 47 base58 digits that decode to 0xec 0x01 || 32 bytes (X25519), and to 0xed 0x02 || 32 bytes (a wrong second byte).
      const x25519 = `did:key:z${base58btcEncode(Uint8Array.from([0xec, 0x01, ...bytes((VECTORS[0] as (typeof VECTORS)[number]).keyHex)]))}`;
      const wrongSecond = `did:key:z${base58btcEncode(Uint8Array.from([0xed, 0x02, ...bytes((VECTORS[0] as (typeof VECTORS)[number]).keyHex)]))}`;

      for (const candidate of [x25519, wrongSecond]) {
        expect(candidate).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]{47}$/);
        expect(isDidKey(candidate)).toBe(false);
      }
    });

    it('refuses a non-string without throwing', () => {
      // A Symbol and a null-prototype object make RegExp.test throw when coerced, so only the typeof guard keeps them from throwing.
      for (const value of [undefined, null, 42, {}, [], Symbol('did'), Object.create(null)]) {
        expect(isDidKey(value)).toBe(false);
        expect(didKeyPublicKey(value)).toBeNull();
        expect(didKeyPublicBytes(value)).toBeNull();
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
      // Top byte below 0x10: the hex of the number has an odd length and needs a leading zero.
      ['0f', 'G'],
      ['0a0b', 'mL'],
      ['010203', 'Ldp'],
      ['00000f', '11G'],
    ])('encodes %s and decodes it back', (hex, text) => {
      const input = bytes(hex);

      expect(base58btcEncode(input)).toBe(text);
      expect(Buffer.from(base58btcDecode(text) as Uint8Array).toString('hex')).toBe(hex);
    });

    it('refuses a character outside the alphabet', () => {
      for (const char of ['0', 'O', 'I', 'l', '+']) {
        expect(base58btcDecode(char)).toBeNull();
      }
    });
  });
});

/** A little-endian hex string as an unsigned integer. */
function leInt(hex: string): bigint {
  return BigInt(`0x${Buffer.from(hex, 'hex').reverse().toString('hex')}`);
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/** RFC 8032 section 5.1.3: x from y and the sign bit, on the twisted Edwards curve with parameter d. */
function recoverX(y: bigint, sign: bigint, p: bigint, d: bigint): bigint {
  const x2 = (((y * y - 1n + p) % p) * modPow(d * y * y + 1n, p - 2n, p)) % p;
  let x = modPow(x2, (p + 3n) / 8n, p);
  if ((x * x - x2 + p) % p !== 0n) x = (x * modPow(2n, (p - 1n) / 4n, p)) % p;
  if ((x * x - x2 + p) % p !== 0n) throw new Error('not on the curve');
  return (x & 1n) === sign ? x : p - x;
}
