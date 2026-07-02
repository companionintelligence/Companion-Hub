import crypto from 'node:crypto';

/**
 * Shared HMAC signing contract for the Traefik forward-auth identity header.
 *
 * The forward-auth endpoint (`GET /api/auth/traefik`) returns the authenticated
 * username in `X-CI-Hub-User`. Historically that header was unsigned, so any
 * container able to reach a backing app on `ci_os_hub_network` could forge it
 * and impersonate a user to any consumer that trusted it (see
 * CI-Engineering/architecture/subsystems/security-trust-and-ops.md, gap #5).
 *
 * This module signs the header with HMAC-SHA256 keyed on a secret shared between
 * the Hub and the identity consumer (e.g. CI-Server). A consumer that knows the
 * secret can verify the signature before trusting the identity; a forger that
 * does not know the secret cannot produce a valid signature.
 *
 * A timestamp (ms since Unix epoch) is signed alongside the username to bound replay: a
 * consumer rejects signatures older than a small skew window.
 *
 * Canonical message: `${username}\n${timestampMs}` (UTF-8).
 * Signature encoding: lowercase hex of the HMAC-SHA256 digest.
 *
 * This contract is duplicated (by design, kept in lock-step) in CI-Server at
 * `backend/apps/api/src/common/crypto/hub-forward-auth.ts`.
 */

export const FORWARD_AUTH_USER_HEADER = 'X-CI-Hub-User';
export const FORWARD_AUTH_TIMESTAMP_HEADER = 'X-CI-Hub-User-Timestamp';
export const FORWARD_AUTH_SIGNATURE_HEADER = 'X-CI-Hub-User-Signature';

export interface SignedForwardAuthHeaders {
  [FORWARD_AUTH_USER_HEADER]: string;
  [FORWARD_AUTH_TIMESTAMP_HEADER]: string;
  [FORWARD_AUTH_SIGNATURE_HEADER]: string;
}

/** Build the canonical message that gets signed. Keep in lock-step with the consumer. */
export function buildForwardAuthMessage(username: string, timestampMs: number): string {
  return `${username}\n${timestampMs}`;
}

/** Compute the lowercase-hex HMAC-SHA256 signature for a username at a given time. */
export function signForwardAuthUser(secret: string, username: string, timestampMs: number): string {
  return crypto.createHmac('sha256', secret).update(buildForwardAuthMessage(username, timestampMs)).digest('hex');
}

/**
 * Produce the full set of signed headers for a username.
 *
 * @param secret shared HMAC secret; must be non-empty
 * @param username authenticated username to attest
 * @param now injectable clock (ms since epoch), defaults to Date.now()
 */
export function buildSignedForwardAuthHeaders(secret: string, username: string, now: number = Date.now()): SignedForwardAuthHeaders {
  if (!secret) {
    throw new Error('Cannot sign forward-auth header without a shared secret');
  }

  const timestamp = String(now);

  return {
    [FORWARD_AUTH_USER_HEADER]: username,
    [FORWARD_AUTH_TIMESTAMP_HEADER]: timestamp,
    [FORWARD_AUTH_SIGNATURE_HEADER]: signForwardAuthUser(secret, username, now),
  };
}
