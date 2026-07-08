import crypto from 'node:crypto';

/**
 * Signer for the Hub -> CI-Server app-connect calls (`/connect/exchange`,
 * `/connect/revoke`, `/connect/rotate`).
 *
 * Binds the signature to the specific request (method + path + body hash) plus a
 * per-request nonce and timestamp, so a captured header set can't be replayed,
 * redirected to another endpoint, or have its body swapped. Keyed on the
 * dedicated forward-auth shared secret. Kept in lock-step with the verifier in
 * CI-Server at `backend/apps/api/src/common/crypto/connect-request-auth.ts`.
 */

export const CONNECT_TIMESTAMP_HEADER = 'X-CI-Connect-Timestamp';
export const CONNECT_NONCE_HEADER = 'X-CI-Connect-Nonce';
export const CONNECT_SIGNATURE_HEADER = 'X-CI-Connect-Signature';

export interface SignedConnectHeaders {
  [CONNECT_TIMESTAMP_HEADER]: string;
  [CONNECT_NONCE_HEADER]: string;
  [CONNECT_SIGNATURE_HEADER]: string;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Deterministic JSON (recursively sorted keys). Must match the verifier. */
export function canonicalizeBody(body: unknown): string {
  const seen = new WeakSet<object>();

  const walk = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (seen.has(value as object)) {
      return null;
    }
    seen.add(value as object);
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = walk((value as Record<string, unknown>)[key]);
    }
    return out;
  };

  return JSON.stringify(walk(body ?? {}));
}

/** The canonical string that both sides sign. Must match the verifier. */
export function buildConnectMessage(method: string, path: string, timestampMs: number, nonce: string, body: unknown): string {
  return [method.toUpperCase(), path, String(timestampMs), nonce, sha256Hex(canonicalizeBody(body))].join('\n');
}

/**
 * Produce the signed headers for a connect request.
 *
 * @param secret dedicated forward-auth shared secret; must be non-empty
 * @param method HTTP method (e.g. POST)
 * @param path request path only (no host, no query) — must match what CI-Server sees
 * @param body request body object (will be sent as JSON)
 * @param now injectable clock (ms)
 */
export function buildSignedConnectHeaders(
  secret: string,
  method: string,
  path: string,
  body: unknown,
  now: number = Date.now(),
): SignedConnectHeaders {
  if (!secret) {
    throw new Error('Cannot sign a connect request without a shared secret');
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(buildConnectMessage(method, path, now, nonce, body))
    .digest('hex');

  return {
    [CONNECT_TIMESTAMP_HEADER]: String(now),
    [CONNECT_NONCE_HEADER]: nonce,
    [CONNECT_SIGNATURE_HEADER]: signature,
  };
}
