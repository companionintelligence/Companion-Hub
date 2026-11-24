// vendored-from: @companionintelligence/auth@0.0.0 packages/auth/src/internal.ts
/**
 * Small helpers shared by the identity-contract modules. Not part of the public
 * surface (no subpath export). WebCrypto and WHATWG URL only, so the code runs in
 * browsers, Node 22 and Deno with no Node-specific imports.
 */

/** base64url (RFC 4648 section 5) without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Compare two strings without returning early at the first differing character.
 * Length differences are folded into the result, so unequal lengths compare unequal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/** The only loopback hosts that may use plain http (RFC 8252 section 7.3). */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Parse an absolute URL. The error names the field, never the value. */
export function parseAbsoluteUrl(raw: string, label: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new TypeError(`${label} is not an absolute URL`);
  }
}

/**
 * An endpoint that receives the authorization code, the code verifier or the
 * tokens must be https. Plain http is allowed only on this machine, for local
 * development against a Portal running here: `localhost` (which always resolves to
 * loopback), 127.0.0.1 or [::1]. The redirect-URI rule in authorize.ts is stricter
 * and does not accept `localhost`.
 */
export function assertSecureEndpoint(raw: string, label: string): URL {
  const url = parseAbsoluteUrl(raw, label);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && (isLoopbackHost(url.hostname) || url.hostname === 'localhost')) return url;
  throw new TypeError(`${label} must use https (or http on localhost, 127.0.0.1 or [::1])`);
}
