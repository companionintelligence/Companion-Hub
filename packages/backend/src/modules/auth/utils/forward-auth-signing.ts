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
 * A username is the person's to change, so it is no key for anything an app keeps. When forward
 * auth knows which Hub person it is signing for, it also signs their stable id: `X-CI-Hub-User-Id`
 * (`user.public_id`, minted once, never reused) and `X-CI-Hub-User-Issuer`
 * (`urn:ci-hub:<user_directory.directory_id>`), under a second signature over
 * `ci-hub-user-id/1\n${issuer}\n${userId}\n${username}\n${timestampMs}`. That binds the id to the
 * same username and timestamp, and the prefix keeps it from ever reading as the first message. The
 * three original headers are unchanged, so a consumer that only knows them verifies exactly what
 * it always did. See CI-Engineering architecture/identity/hub-memory-account-link.md.
 *
 * This contract is duplicated (by design, kept in lock-step) in CI-Server at
 * `backend/apps/api/src/common/crypto/hub-forward-auth.ts`.
 */

export const FORWARD_AUTH_USER_HEADER = 'X-CI-Hub-User';
export const FORWARD_AUTH_TIMESTAMP_HEADER = 'X-CI-Hub-User-Timestamp';
export const FORWARD_AUTH_SIGNATURE_HEADER = 'X-CI-Hub-User-Signature';
export const FORWARD_AUTH_USER_ISSUER_HEADER = 'X-CI-Hub-User-Issuer';
export const FORWARD_AUTH_USER_ID_HEADER = 'X-CI-Hub-User-Id';
export const FORWARD_AUTH_USER_ID_SIGNATURE_HEADER = 'X-CI-Hub-User-Id-Signature';

/** Prefix of every Hub user-directory issuer. Never a valid OIDC issuer, which is always an https URL. */
export const HUB_ISSUER_PREFIX = 'urn:ci-hub:';

/** A Hub person's stable identity: who they are for good, whatever their username says today. */
export interface ForwardAuthStableId {
  /** `urn:ci-hub:<directory uuid>` — the user directory that minted the id. */
  issuer: string;
  /** The person's `user.public_id`. */
  userId: string;
}

export interface SignedForwardAuthHeaders {
  [FORWARD_AUTH_USER_HEADER]: string;
  [FORWARD_AUTH_TIMESTAMP_HEADER]: string;
  [FORWARD_AUTH_SIGNATURE_HEADER]: string;
  [FORWARD_AUTH_USER_ISSUER_HEADER]?: string;
  [FORWARD_AUTH_USER_ID_HEADER]?: string;
  [FORWARD_AUTH_USER_ID_SIGNATURE_HEADER]?: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HUB_ISSUER_PATTERN = new RegExp(`^${HUB_ISSUER_PREFIX}${UUID}$`);
const HUB_USER_ID_PATTERN = new RegExp(`^${UUID}$`);

/** Build the canonical message that gets signed. Keep in lock-step with the consumer. */
export function buildForwardAuthMessage(username: string, timestampMs: number): string {
  return `${username}\n${timestampMs}`;
}

/** Compute the lowercase-hex HMAC-SHA256 signature for a username at a given time. */
export function signForwardAuthUser(secret: string, username: string, timestampMs: number): string {
  return crypto.createHmac('sha256', secret).update(buildForwardAuthMessage(username, timestampMs)).digest('hex');
}

/** Build the canonical message the stable id is signed over. Keep in lock-step with the consumer. */
export function buildForwardAuthUserIdMessage(issuer: string, userId: string, username: string, timestampMs: number): string {
  return `ci-hub-user-id/1\n${issuer}\n${userId}\n${username}\n${timestampMs}`;
}

/** Compute the lowercase-hex HMAC-SHA256 signature over a stable id, its username and timestamp. */
export function signForwardAuthUserId(secret: string, issuer: string, userId: string, username: string, timestampMs: number): string {
  return crypto
    .createHmac('sha256', secret)
    .update(buildForwardAuthUserIdMessage(issuer, userId, username, timestampMs))
    .digest('hex');
}

/**
 * Produce the full set of signed headers for a username, and for the person's stable id when known.
 *
 * @param secret shared HMAC secret; must be non-empty
 * @param username authenticated username to attest
 * @param now injectable clock (ms since epoch), defaults to Date.now()
 * @param stableId the person's stable id; omitted (or null) signs the username alone, as before
 */
export function buildSignedForwardAuthHeaders(
  secret: string,
  username: string,
  now: number = Date.now(),
  stableId?: ForwardAuthStableId | null,
): SignedForwardAuthHeaders {
  if (!secret) {
    throw new Error('Cannot sign forward-auth header without a shared secret');
  }

  const timestamp = String(now);
  const headers: SignedForwardAuthHeaders = {
    [FORWARD_AUTH_USER_HEADER]: username,
    [FORWARD_AUTH_TIMESTAMP_HEADER]: timestamp,
    [FORWARD_AUTH_SIGNATURE_HEADER]: signForwardAuthUser(secret, username, now),
  };

  if (stableId) {
    headers[FORWARD_AUTH_USER_ISSUER_HEADER] = stableId.issuer;
    headers[FORWARD_AUTH_USER_ID_HEADER] = stableId.userId;
    headers[FORWARD_AUTH_USER_ID_SIGNATURE_HEADER] = signForwardAuthUserId(secret, stableId.issuer, stableId.userId, username, now);
  }

  return headers;
}

export type ForwardAuthVerifyResult =
  | { ok: true; username: string; stableId: ForwardAuthStableId | null }
  | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'expired' | 'bad_signature' | 'bad_stable_id' };

const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;

function signaturesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a signed forward-auth header set (same contract as CI-Server).
 */
export function verifyForwardAuthHeaders(
  secret: string,
  headers: {
    user?: string | null;
    timestamp?: string | null;
    signature?: string | null;
    issuer?: string | null;
    userId?: string | null;
    userIdSignature?: string | null;
  },
  opts: { now?: number; maxSkewMs?: number } = {},
): ForwardAuthVerifyResult {
  const username = headers.user;
  const timestampRaw = headers.timestamp;
  const signature = headers.signature;

  if (!secret || !username || !timestampRaw || !signature) {
    return { ok: false, reason: 'missing_headers' };
  }

  const timestampMs = Number(timestampRaw);
  if (!Number.isFinite(timestampMs) || !Number.isInteger(timestampMs)) {
    return { ok: false, reason: 'bad_timestamp' };
  }

  const now = opts.now ?? Date.now();
  const maxSkewMs = opts.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  if (Math.abs(now - timestampMs) > maxSkewMs) {
    return { ok: false, reason: 'expired' };
  }

  if (!signaturesEqual(signature, signForwardAuthUser(secret, username, timestampMs))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Optional, but never half-present: an id without its signature (or a malformed one) can only
  // be a client's own, so it rejects the whole identity rather than being ignored.
  const { issuer, userId, userIdSignature } = headers;
  if (!issuer && !userId && !userIdSignature) {
    return { ok: true, username, stableId: null };
  }

  if (!issuer || !userId || !userIdSignature || !HUB_ISSUER_PATTERN.test(issuer) || !HUB_USER_ID_PATTERN.test(userId)) {
    return { ok: false, reason: 'bad_stable_id' };
  }

  if (!signaturesEqual(userIdSignature, signForwardAuthUserId(secret, issuer, userId, username, timestampMs))) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, username, stableId: { issuer, userId } };
}
