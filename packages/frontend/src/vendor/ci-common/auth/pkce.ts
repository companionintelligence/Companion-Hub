// vendored-from: @companionintelligence/auth@0.0.0 packages/auth/src/pkce.ts
/**
 * PKCE (RFC 7636) helpers for the authorization-code flow against CI-Portal.
 *
 * Same scheme as CI-Server's OidcController:
 *   verifier  = base64url(32 random bytes)            (43 characters)
 *   challenge = base64url(SHA-256(verifier as ASCII))
 *   method    = 'S256'
 *
 * WebCrypto only (globalThis.crypto), so this runs in browsers, Node 22 and Deno.
 * The verifier is a secret. Keep it in memory or in the secure store until the token
 * exchange, and never send it to the authorize endpoint.
 */
import { CODE_CHALLENGE_METHOD } from './config.js';
import { toBase64Url } from './internal.js';

export interface PkcePair {
  /** High-entropy secret kept private until the token exchange. */
  readonly verifier: string;
  /** base64url(SHA-256(verifier)). Safe to put on the authorize URL. */
  readonly challenge: string;
  /** Always `'S256'` for this platform. */
  readonly method: typeof CODE_CHALLENGE_METHOD;
}

/** RFC 7636 section 4.1: 43 to 128 characters from the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Create a fresh PKCE pair. The verifier is always 32 random bytes, which gives the
 * 43-character minimum RFC 7636 requires. There is no length parameter, so a caller
 * cannot weaken it.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = await deriveChallenge(verifier);
  return { verifier, challenge, method: CODE_CHALLENGE_METHOD };
}

/**
 * Recompute the S256 challenge for a verifier: base64url(SHA-256(verifier bytes)).
 * The verifier must already be valid under RFC 7636 section 4.1, so a weak or
 * malformed verifier fails here instead of producing a challenge.
 */
export async function deriveChallenge(verifier: string): Promise<string> {
  if (!VERIFIER_PATTERN.test(verifier)) {
    throw new TypeError('code verifier must be 43 to 128 unreserved characters (RFC 7636 section 4.1)');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Generate an opaque `state` value for the CSRF check on the redirect round trip.
 * 32 random bytes, so 256 bits, well above the 128-bit minimum.
 */
export function createStateNonce(): string {
  return toBase64Url(randomBytes(32));
}
