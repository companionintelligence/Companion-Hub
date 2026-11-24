/**
 * Browser-side W3C `did:key` (Ed25519) + SIOPv2 self-issued proof builder for Hub's optional
 * `CI_HUB_DID_AUTH` flow (`POST /api/auth/did/verify` and `POST /api/auth/did/link`).
 *
 * Keys are exportable only when explicitly requested for caller-managed backup (e.g. session/local
 * download or opt-in local storage in this browser); server routes never receive private keys.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);
const DID_TOKEN_TTL_SECONDS = 120;

export interface BrowserDidKeyPair {
  did: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

export interface DidChallengePayload {
  nonce: string;
  audience: string;
}

function encodeBase58Btc(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) {
    num = (num << 8n) + BigInt(byte);
  }

  let encoded = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    num /= 58n;
  }

  for (const byte of bytes) {
    if (byte === 0) {
      encoded = `1${encoded}`;
    } else {
      break;
    }
  }

  return encoded;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeJsonBase64Url(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function encodeEd25519DidKey(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 public key, got ${rawPublicKey.length} bytes`);
  }

  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + rawPublicKey.length);
  prefixed.set(ED25519_MULTICODEC, 0);
  prefixed.set(rawPublicKey, ED25519_MULTICODEC.length);
  return `did:key:z${encodeBase58Btc(prefixed)}`;
}

export async function isWebCryptoEd25519Supported(): Promise<boolean> {
  if (typeof globalThis.crypto?.subtle?.generateKey !== 'function') {
    return false;
  }

  try {
    await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

export async function generateBrowserDidKeyPair(): Promise<BrowserDidKeyPair> {
  if (typeof globalThis.crypto?.subtle?.generateKey !== 'function') {
    throw new Error('WebCrypto Ed25519 key generation is unavailable in this browser.');
  }

  const pair = (await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const rawPublic = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
  const publicKeyJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateKeyJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);

  return {
    did: encodeEd25519DidKey(rawPublic),
    publicKeyJwk,
    privateKeyJwk,
  };
}

export async function createSiopProofToken(
  keyPair: BrowserDidKeyPair,
  challenge: DidChallengePayload,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const privateKey = await globalThis.crypto.subtle.importKey('jwk', keyPair.privateKeyJwk, { name: 'Ed25519' }, false, ['sign']);

  const header = encodeJsonBase64Url({
    alg: 'EdDSA',
    typ: 'JWT',
    kid: keyPair.did,
  });

  const payload = encodeJsonBase64Url({
    iss: keyPair.did,
    sub: keyPair.did,
    aud: challenge.audience,
    nonce: challenge.nonce,
    iat: nowSeconds,
    exp: nowSeconds + DID_TOKEN_TTL_SECONDS,
  });

  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(signingInput)));

  return `${signingInput}.${toBase64Url(signature)}`;
}
