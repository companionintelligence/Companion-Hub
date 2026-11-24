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
 * ═══ WEAK KEYS ARE REFUSED TOO ═══
 *
 * A key that is a small-order point (the identity, or a point of order 2, 4 or 8) makes a signature
 * verify with NO private key: `8A` is the identity, so a signature over any message passes the check
 * (the cofactored equation, and OpenSSL's check too, accept it). A DID for such a key would be a
 * "possession" factor that nobody has to possess. The same points have second spellings, because
 * the encoding is a 255-bit `y` and a sign bit, and any `y` of at least `p = 2^255 - 19` is the
 * same point as `y - p`: two accepted DIDs for one key, which the rule above forbids. Both are
 * refused by {@link isWeakEd25519Key}, with no curve library: read `y` little-endian with the sign
 * bit cleared, refuse `y >= p`, and refuse the five `y` values of the eight torsion points.
 *
 * ═══ STRINGS THAT ARE NOT A POINT ARE REFUSED TOO, AS DEFENCE IN DEPTH ═══
 *
 * About half of all 32-byte strings are not points on the curve. Nothing verifies under such a key,
 * and no Hub route links a DID that was typed in (a link is made from a token whose `iss` must verify
 * under that key), so refusing them changes no outcome here. It is NOT a typo guard: one wrong
 * character in a `did:key` is another valid `did:key` about 46% of the time. {@link isEd25519CurvePoint}
 * is a port of Companion Memory's, where an owner does type a peer's DID. It decides by RFC 8032
 * section 5.1.3 (`x^2 = (y^2 - 1) / (d y^2 + 1)` must be a square). It is neither a weak-key check (a
 * small-order point is on the curve) nor a subgroup check.
 *
 * Also refused, by being out of scope: the DIDs whose key can ROTATE (`did:web`, `did:webvh`,
 * `did:scid:vh`, KERI `E…` AIDs). Reading one means resolving a log, and a verifier that skipped
 * that would accept a key its owner had retired.
 *
 * The same rules, and the same independently produced did:key vectors, as Companion Memory's
 * `domains/peers/didKeyId.ts`; the two repositories each carry their own copy. The curve vectors are
 * kept here in full; Memory's curve spec carries a subset of them.
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

/** The field prime of Curve25519 and Ed25519, `p = 2^255 - 19`. */
const FIELD_PRIME = (1n << 255n) - 19n;

/** Bit 255 of an Ed25519 public key is the sign of `x`; the 255 bits below it are `y`. */
const Y_MASK = (1n << 255n) - 1n;

/**
 * `y` of the two order-8 points, as libsodium's small-order blocklist writes it (little-endian), and
 * of its negation `p - y`. Recomputed and checked against the group order in the test, and against
 * libsodium's decimal comments (2707385501144840649318225287225658788936804267575313519463743609750303402022
 * and 55188659117513257062467267217118295137698188065244968500265048394206261417927).
 */
const ORDER_8_Y = littleEndian(Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex'));

/**
 * `y` of the eight points whose order divides 8: 0 (order 4), 1 (the identity), p-1 (order 2) and
 * the four order-8 points, which share two values of `y` between their two signs of `x`.
 */
const SMALL_ORDER_Y: ReadonlySet<bigint> = new Set([0n, 1n, FIELD_PRIME - 1n, ORDER_8_Y, FIELD_PRIME - ORDER_8_Y]);

/** d = -121665 / 121666 (mod p), the Edwards curve constant of Ed25519. */
const CURVE_D = ((FIELD_PRIME - 121665n) * modPow(121666n, FIELD_PRIME - 2n)) % FIELD_PRIME;

/** Whether `value` is an Ed25519 `did:key` that is well formed and not weak. See the header. */
export function isDidKey(value: unknown): value is string {
  return didKeyPublicBytes(value) != null;
}

/**
 * Whether a 32-byte Ed25519 public key is one nobody should accept as an identity: a point of order
 * 1, 2, 4 or 8 (in either sign), or a non-canonical spelling (`y >= p`) of any point. Every key
 * generated honestly passes; the 14 small-order encodings and every `y >= p` encoding fail.
 *
 * Total, like Companion Memory's: anything that is not exactly 32 bytes in a `Uint8Array` is not a
 * key, so it is "weak" and never accepted (a `null`, a plain array, a `Uint16Array`, the 34 bytes of
 * `0xed01 || key`, the 44 bytes of an SPKI, a string).
 */
export function isWeakEd25519Key(key: unknown): boolean {
  if (!(key instanceof Uint8Array) || key.length !== ED25519_KEY_BYTES) {
    return true;
  }

  const y = littleEndian(key) & Y_MASK;

  return y >= FIELD_PRIME || SMALL_ORDER_Y.has(y);
}

/**
 * Whether `key` is 32 bytes that decode to a point on the Ed25519 curve (RFC 8032 section 5.1.3, read
 * the way the RFC reads it: little-endian, bit 255 the sign of `x`, the other 255 bits `y`). A `y` of
 * at least `p` is refused, as the RFC refuses it, and so is "negative zero" (`x = 0` with the sign bit
 * set). A point exists for `y` iff `x^2 = (y^2 - 1) / (d y^2 + 1)` is a square, which Euler's
 * criterion decides. Any other input is not a point.
 *
 * Checked against the RFC's own decoding (the `(p+3)/8` square-root method, a different algorithm) on
 * 130 distinct encodings written by a Python implementation: the edge cases around every small-order
 * `y`, the non-canonical `y`s and random strings; `ed25519-oncurve-vectors.json` is that list.
 */
export function isEd25519CurvePoint(key: unknown): boolean {
  if (!(key instanceof Uint8Array) || key.length !== ED25519_KEY_BYTES) {
    return false;
  }

  const value = littleEndian(key);
  const negative = value >> 255n === 1n;
  const y = value & Y_MASK;
  if (y >= FIELD_PRIME) {
    return false;
  }

  const ySquared = (y * y) % FIELD_PRIME;
  const numerator = (ySquared + FIELD_PRIME - 1n) % FIELD_PRIME;
  const denominator = (CURVE_D * ySquared + 1n) % FIELD_PRIME;
  if (denominator === 0n) {
    return false;
  }

  const xSquared = (numerator * modPow(denominator, FIELD_PRIME - 2n)) % FIELD_PRIME;
  if (xSquared === 0n) {
    return !negative;
  }

  return modPow(xSquared, (FIELD_PRIME - 1n) / 2n) === 1n;
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
  if (isWeakEd25519Key(key) || !isEd25519CurvePoint(key)) {
    return null;
  }

  // A backstop, not a layer a test can reach: every string that passes the shape check above
  // re-encodes to itself, because a 47-digit base58 number has one spelling. It stays so that a
  // future loosening of the pattern cannot admit a second spelling of one key.
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
 * The `did:key` for a raw 32-byte Ed25519 public key. Null for anything that is not exactly 32 bytes
 * in a `Uint8Array`, so a caller that hands over a certificate, a 33-byte compressed point, a plain
 * array or `null` gets a refusal and not a wrong identifier or an exception, and null for a weak key
 * or a string of bytes that is not a point, so this never mints a DID that {@link isDidKey} refuses.
 */
export function didKeyFromPublicKey(key: unknown): string | null {
  if (!(key instanceof Uint8Array) || key.length !== ED25519_KEY_BYTES || isWeakEd25519Key(key) || !isEd25519CurvePoint(key)) {
    return null;
  }

  return encodeDidKey(key);
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

/** The spelling of a key, with no check on the key. Only {@link didKeyFromPublicKey} calls it. */
function encodeDidKey(key: Uint8Array): string {
  const bytes = new Uint8Array(ED25519_PUB_MULTICODEC.length + key.length);
  bytes.set(ED25519_PUB_MULTICODEC, 0);
  bytes.set(key, ED25519_PUB_MULTICODEC.length);

  return `${DID_KEY_PREFIX}${MULTIBASE_BASE58BTC}${base58btcEncode(bytes)}`;
}

/** A little-endian byte string as an unsigned integer. */
function littleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of Array.from(bytes).reverse()) {
    value = (value << 8n) | BigInt(byte);
  }

  return value;
}

/** `base ** exponent mod p`, by square and multiply. */
function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let square = base % FIELD_PRIME;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if ((rest & 1n) === 1n) {
      result = (result * square) % FIELD_PRIME;
    }

    square = (square * square) % FIELD_PRIME;
  }

  return result;
}
