import { createPublicKey, type KeyObject } from 'node:crypto';

/**
 * The W3C CCG `did:key` form of one Ed25519 public key: `did:key:z6Mk…`.
 *
 * This is NOT the in-tree KERI module (`packages/common/src/keri`, frozen as not interoperable) and
 * shares nothing with it. A `did:key` is a published, ledger-free method whose whole identifier is
 * the key, with an encoding fixed by two public tables (multicodec and multibase). Reading one needs
 * no network and no log, which is what lets the Hub check a signature made by it with nothing else.
 *
 *   did:key:  +  "z"  +  base58btc( 0xed 0x01  ||  32-byte public key )
 *
 * `z` is the multibase code for base58btc; `0xed 0x01` is the unsigned-varint multicodec for an
 * Ed25519 public key. Every such DID is 48 characters after `did:key:` and starts `z6Mk`.
 *
 * Refused: any other key type (X25519 `z6LS…`, secp256k1 `zQ3s…`, P-256 `zDn…`), a DID URL
 * (`…#z6Mk…`, a query, a path), and any string that decodes but does not re-encode to itself. One
 * key has one spelling: a binding is matched on the exact string, so two spellings of one key would
 * be two people.
 *
 * Also refused, by being out of scope: the DIDs whose key can ROTATE (`did:web`, `did:webvh`,
 * `did:scid:vh`, KERI `E…` AIDs). Reading one means resolving a log, and a verifier that skipped
 * that would accept a key its owner had retired.
 *
 * The same rules, and the same independently produced vectors, as Companion Memory's
 * `domains/peers/didKeyId.ts`; the two repositories each carry their own copy.
 */

const DID_KEY_PREFIX = 'did:key:';

/** The multibase code for base58btc, which `did:key` puts directly after the method. */
const MULTIBASE_BASE58BTC = 'z';

/** Unsigned-varint multicodec for an Ed25519 public key. */
const ED25519_PUB_MULTICODEC = Uint8Array.of(0xed, 0x01);

const ED25519_KEY_BYTES = 32;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * `did:key:z` and 47 base58btc characters: 34 bytes (2 multicodec + 32 key) is always exactly 47
 * digits, because the leading byte is 0xed. A cheap shape check in front of the real decode.
 */
const DID_KEY_PATTERN = /^did:key:z[1-9A-HJ-NP-Za-km-z]{47}$/;

/** Whether `value` is a canonical Ed25519 `did:key`. */
export function isDidKey(value: unknown): value is string {
  return didKeyPublicBytes(value) != null;
}

/**
 * The 32-byte Ed25519 public key a `did:key` spells out, or null for anything else.
 *
 * The round trip is the canonical-form check: a decode that does not re-encode to the input is
 * refused, so the one key has the one identifier.
 */
export function didKeyPublicBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !DID_KEY_PATTERN.test(value)) {
    return null;
  }

  const raw = base58btcDecode(value.slice(DID_KEY_PREFIX.length + MULTIBASE_BASE58BTC.length));
  if (
    raw == null ||
    raw.length !== ED25519_PUB_MULTICODEC.length + ED25519_KEY_BYTES ||
    raw[0] !== ED25519_PUB_MULTICODEC[0] ||
    raw[1] !== ED25519_PUB_MULTICODEC[1]
  ) {
    return null;
  }

  const key = raw.subarray(ED25519_PUB_MULTICODEC.length);

  return didKeyFromPublicKey(key) === value ? key : null;
}

/** The Node verifying key a `did:key` spells out, or null. Derived from the DID alone. */
export function didKeyPublicKey(value: unknown): KeyObject | null {
  const key = didKeyPublicBytes(value);
  if (key == null) {
    return null;
  }

  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key).toString('base64url') }, format: 'jwk' });
  } catch {
    return null;
  }
}

/**
 * The `did:key` for a raw 32-byte Ed25519 public key. Null for any other length, so a caller that
 * hands over a certificate or a 33-byte compressed point gets a refusal and not a wrong identifier.
 */
export function didKeyFromPublicKey(key: Uint8Array): string | null {
  if (key.length !== ED25519_KEY_BYTES) {
    return null;
  }

  const bytes = new Uint8Array(ED25519_PUB_MULTICODEC.length + key.length);
  bytes.set(ED25519_PUB_MULTICODEC, 0);
  bytes.set(key, ED25519_PUB_MULTICODEC.length);

  return `${DID_KEY_PREFIX}${MULTIBASE_BASE58BTC}${base58btcEncode(bytes)}`;
}

/** Bitcoin-alphabet base58, big-endian, a leading zero byte for each leading `1`. */
export function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }

  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  let digits = '';
  while (value > 0n) {
    digits = BASE58_ALPHABET[Number(value % 58n)] + digits;
    value /= 58n;
  }

  return '1'.repeat(zeros) + digits;
}

/** The inverse of {@link base58btcEncode}; null when a character is outside the alphabet. */
export function base58btcDecode(text: string): Uint8Array | null {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') {
    zeros += 1;
  }

  let value = 0n;
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) {
      return null;
    }

    value = value * 58n + BigInt(digit);
  }

  let hex = value.toString(16);
  if (value === 0n) {
    hex = '';
  } else if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }

  const body = Buffer.from(hex, 'hex');
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);

  return out;
}
