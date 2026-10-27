import { createHash } from 'node:crypto';

/**
 * CESR (Composable Event Streaming Representation) primitives for KERI.
 * Prefix codes:
 *   - 'B': Ed25519 32-byte public key (44 chars base64url)
 *   - 'E': SHA-256 32-byte digest / SAID (44 chars base64url)
 *   - '0A': Ed25519 64-byte signature (88 chars base64url)
 */
export const CESR_ED25519_PUBKEY_PREFIX = 'B';
export const CESR_SHA256_DIGEST_PREFIX = 'E';
export const CESR_ED25519_SIG_PREFIX = '0A';

/** Converts a Buffer to URL-safe Base64 without trailing padding '='. */
export function toBase64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Converts a URL-safe Base64 string to a Buffer. */
export function fromBase64Url(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/** Formats a 32-byte Ed25519 public key buffer into a CESR-qualified string with prefix 'B'. */
export function encodeCesrPublicKey(pubkey: Buffer): string {
  if (pubkey.length !== 32) {
    throw new Error(`Invalid Ed25519 public key length: expected 32 bytes, got ${pubkey.length}`);
  }
  // CESR 'B' prefix indicates 32-byte Ed25519 key (43 base64url chars + 1 prefix = 44 chars)
  return `${CESR_ED25519_PUBKEY_PREFIX}${toBase64Url(pubkey)}`;
}

/** Decodes a CESR-qualified Ed25519 public key into a 32-byte Buffer. */
export function decodeCesrPublicKey(cesrKey: string): Buffer {
  if (!cesrKey.startsWith(CESR_ED25519_PUBKEY_PREFIX)) {
    throw new Error(`Invalid CESR public key prefix: expected '${CESR_ED25519_PUBKEY_PREFIX}', got '${cesrKey[0]}'`);
  }
  const buf = fromBase64Url(cesrKey.slice(1));
  if (buf.length !== 32) {
    throw new Error(`Invalid decoded public key length: expected 32 bytes, got ${buf.length}`);
  }
  return buf;
}

/** Computes a CESR-qualified SHA-256 digest of input bytes with prefix 'E'. */
export function computeCesrDigest(data: Buffer | string): string {
  const hash = createHash('sha256').update(data).digest();
  return `${CESR_SHA256_DIGEST_PREFIX}${toBase64Url(hash)}`;
}

/** Formats a 64-byte Ed25519 signature buffer into a CESR-qualified string with prefix '0A'. */
export function encodeCesrSignature(sig: Buffer): string {
  if (sig.length !== 64) {
    throw new Error(`Invalid Ed25519 signature length: expected 64 bytes, got ${sig.length}`);
  }
  return `${CESR_ED25519_SIG_PREFIX}${toBase64Url(sig)}`;
}

/** Decodes a CESR-qualified Ed25519 signature into a 64-byte Buffer. */
export function decodeCesrSignature(cesrSig: string): Buffer {
  if (!cesrSig.startsWith(CESR_ED25519_SIG_PREFIX)) {
    throw new Error(`Invalid CESR signature prefix: expected '${CESR_ED25519_SIG_PREFIX}'`);
  }
  const buf = fromBase64Url(cesrSig.slice(CESR_ED25519_SIG_PREFIX.length));
  if (buf.length !== 64) {
    throw new Error(`Invalid decoded signature length: expected 64 bytes, got ${buf.length}`);
  }
  return buf;
}
