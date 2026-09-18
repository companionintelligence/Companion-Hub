import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import { canonicalBodyHash, joinCanonicalLines } from '@/modules/auth/utils/connect-request-signing';

/**
 * Request signing for peer-to-peer Hub Pool calls.
 *
 * Replaces the directional bearer token with a pinned per-node Ed25519 identity: each Hub holds
 * exactly one secret (its own private key) and, for every peer, only public data. The framing and
 * the body canonicalization are the ones `connect-request-signing.ts` already uses for the
 * Hub -> CI-Server connect calls — deliberately imported rather than re-derived, because that
 * module's `canonicalizeBody` tracks ancestors only (add before recursing, delete after) so a DAG
 * still serializes fully, and a second hand-rolled key-sort would reintroduce the bug it documents.
 *
 * What is genuinely new here, and nothing else:
 *   - Ed25519 instead of an HMAC, so the verifier stores no secret at all.
 *   - A sender line, a sender-FQDN line and a RECIPIENT line, so a captured signature is neither
 *     transferable to another peer nor usable to assert a different name.
 *   - A replay cache, because there is no shared secret to rotate if one leaks.
 */

// ── Wire headers ─────────────────────────────────────────────────────────────

/** The sender's stable pool node UUID. Its presence is what selects the signed branch in the guard. */
export const POOL_NODE_HEADER = 'X-Hub-Pool-Node';
/** The sender's own `nodeFqdn`. Pre-dates signing; now also covered by the signature (see {@link buildPoolMessage}). */
export const POOL_PEER_HEADER = 'X-Hub-Pool-Peer';
export const POOL_TIMESTAMP_HEADER = 'X-Hub-Pool-Timestamp';
export const POOL_NONCE_HEADER = 'X-Hub-Pool-Nonce';
export const POOL_SIGNATURE_HEADER = 'X-Hub-Pool-Signature';
/**
 * The recipient UUID the sender has pinned, in the clear, beside the signature that already covers it.
 *
 * It exists so the receiver can say "that is not me" out loud. A signed request carries the
 * recipient only inside the signature, and a node whose database was recreated has neither the
 * sender's key nor its own old UUID. It can only answer 401, and a 401 looks the same as clock skew
 * or a revoked pairing. That happened on beta-max on 2026-09-16: a compose project-name fix created a
 * fresh `ci_hub_pgdata`, so beta-max got a new UUID and key. Every peer kept probing the old identity
 * and logged `capabilities probe ... failed: 401` for 28 hours, with nothing that said "re-pair".
 *
 * Authenticates nothing and changes no trust decision. The receiver compares it with its own UUID and
 * stops there. See {@link POOL_REFUSAL_HEADER}.
 */
export const POOL_RECIPIENT_HEADER = 'X-Hub-Pool-Recipient';
/**
 * Response header on a 401 that says why, for the one refusal that is safe to name.
 *
 * `PoolPeerGuard` answers every other refusal with the same body, because naming the failed check is
 * an oracle. Only {@link POOL_REFUSAL_IDENTITY_MISMATCH} is named. It says one thing: "the UUID you
 * addressed is not mine". Only a caller that already knows a UUID this node once held can learn
 * anything from it, and that caller is a former peer. The node's current UUID is never disclosed.
 *
 * A header rather than a body field, because `MainExceptionFilter` rebuilds every error body and would
 * drop an extra field.
 */
export const POOL_REFUSAL_HEADER = 'X-Hub-Pool-Refusal';
/** {@link POOL_REFUSAL_HEADER} value: the sender addressed a pool identity this node does not hold. */
export const POOL_REFUSAL_IDENTITY_MISMATCH = 'identity-mismatch';

/** Versioned so a future algorithm change is a parse, not a guess. */
export const POOL_SIGNATURE_PREFIX = 'v1.ed25519.';
/** First line of every signed message: domain separation against any other Ed25519 signature this key ever makes. */
export const POOL_MESSAGE_PREAMBLE = 'ci-hub-pool-v1';

/**
 * Protocol version advertised by `GET /inference/pool/identify`. `2` means "this node can pin a
 * peer identity and verify signed requests"; a node that omits it is protocol 1 and only speaks the
 * bearer handshake.
 */
export const POOL_PROTOCOL_VERSION = 2;

/**
 * Lowest protocol version that can be paired with *by address*.
 *
 * Pairing by address needs the far side to answer a PIN-authenticated `pair/request` with its own
 * MagicDNS name — the name `/identify` deliberately no longer discloses. A protocol-1 node ignores
 * the PIN, answers `{ received: true }`, and leaves the initiator with nothing to key a row on, so
 * the probe says so up front instead of letting the operator find out by failing to pair.
 */
export const MIN_PAIR_BY_ADDRESS_PROTOCOL = 2;

/**
 * Accepted clock skew. Deliberately generous: peers are separate machines with no shared NTP
 * guarantee, and the module already refuses to compare a peer's clock to ours anywhere else
 * (`PoolProxyService.reportedPeerLoad`). The single-use nonce, not the window, is what makes a
 * captured request unreplayable.
 */
export const PEER_SIGNATURE_SKEW_MS = 300_000;
/** Nonce cache ceiling. At the skew window above this is ~33 signed requests/second sustained, an order of magnitude above any real pool. */
export const PEER_NONCE_CACHE_MAX = 10_000;
/** How often the nonce cache drops expired entries on its own, independently of traffic. */
export const PEER_NONCE_SWEEP_MS = 30_000;

/**
 * Stand-in for the body hash on routes whose body is deliberately not signed. A literal that can
 * never be a sha256 hex digest, so a sender cannot downgrade body binding by claiming it — the
 * receiver decides which form applies from the path alone ({@link poolRequestSignsBody}).
 */
const UNSIGNED_BODY_MARKER = '-';

/**
 * Whether a peer-facing path's body is covered by the signature.
 *
 * Control routes (`/pair/*`, `/pair/upgrade`) carry small bodies that decide trust, so they are
 * bound. `/local/*` is the inference forwarding path: the recipient UUID, the nonce and the
 * timestamp already make a captured request non-replayable, and four object traversals plus three
 * serializations of a megabyte embeddings batch *per hop* is not affordable there.
 *
 * A pure function of the path on BOTH sides. Never negotiated, never taken from a header.
 */
export function poolRequestSignsBody(path: string): boolean {
  return !normalizePath(path).includes('/inference/pool/local/');
}

/**
 * The path form both sides sign: pathname only, query dropped.
 *
 * No peer-facing pool route takes a query string, so dropping it costs nothing and removes an
 * entire class of "the proxy re-encoded a parameter" mismatch. Kept as a single function so the
 * sender (which has a URL) and the receiver (which has an Express request) cannot disagree.
 */
export function normalizePath(rawPath: string): string {
  const withoutQuery = rawPath.split('?')[0] ?? '';
  const withoutFragment = withoutQuery.split('#')[0] ?? '';
  return withoutFragment || '/';
}

// ── Key material ─────────────────────────────────────────────────────────────

export interface PoolKeyPairMaterial {
  /** SPKI DER, base64. Public data — this is what a peer pins. */
  publicKey: string;
  /** PKCS8 DER, base64. Only ever stored through `EncryptionService`. */
  privateKey: string;
}

export function generatePoolKeyPair(): PoolKeyPairMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function publicKeyFromBase64(spkiBase64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
}

export function privateKeyFromBase64(pkcs8Base64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(pkcs8Base64, 'base64'), format: 'der', type: 'pkcs8' });
}

/**
 * Short, human-comparable hash of a public key — the first 8 bytes of `sha256(SPKI)`, colon
 * separated. The operator compares this across two screens when confirming a pairing; the full key
 * is only ever needed in-process, so it is the fingerprint and not the key that reaches a surface.
 *
 * Returns `null` for material that is not a parseable key, so a corrupt row renders as "unknown"
 * rather than taking a status page down.
 */
export function publicKeyFingerprint(spkiBase64: string | null | undefined): string | null {
  if (!spkiBase64) {
    return null;
  }
  try {
    const der = publicKeyFromBase64(spkiBase64).export({ type: 'spki', format: 'der' });
    const digest = createHash('sha256').update(der).digest('hex').slice(0, 16);
    return (digest.match(/.{2}/g) ?? []).join(':');
  } catch {
    return null;
  }
}

// ── Message, signing, verification ───────────────────────────────────────────

export interface PoolMessageParts {
  method: string;
  /** Path exactly as sent, including the `/api` prefix. Normalized by {@link normalizePath}. */
  path: string;
  senderNodeUuid: string;
  /**
   * The `nodeFqdn` the sender claims for itself. In the signature because "identity beats address":
   * a signed peer that shows up under a new name has MOVED, and acting on that is a write to a
   * UNIQUE column — so the claim has to be authenticated before anything acts on it.
   */
  senderNodeFqdn: string;
  /** The recipient's UUID *as the sender has it pinned*, which is what makes a signature non-transferable. */
  recipientNodeUuid: string;
  timestampMs: number;
  nonce: string;
  body: unknown;
}

export function buildPoolMessage(parts: PoolMessageParts): string {
  const path = normalizePath(parts.path);
  return joinCanonicalLines([
    POOL_MESSAGE_PREAMBLE,
    parts.method.toUpperCase(),
    path,
    parts.senderNodeUuid,
    parts.senderNodeFqdn,
    parts.recipientNodeUuid,
    String(parts.timestampMs),
    parts.nonce,
    poolRequestSignsBody(path) ? canonicalBodyHash(parts.body) : UNSIGNED_BODY_MARKER,
  ]);
}

export type SignedPoolHeaders = Record<string, string>;

/**
 * Produce the headers a signed peer request carries: the five that the signature covers, plus
 * {@link POOL_RECIPIENT_HEADER}. Never emits an `Authorization` header, which is the bearer path.
 *
 * A receiver built before the recipient header ignores it, and a receiver built after it skips the
 * check when the header is missing. So a mixed-version fleet verifies exactly as it did before.
 */
export function buildSignedPoolHeaders(
  privateKey: KeyObject,
  parts: Omit<PoolMessageParts, 'timestampMs' | 'nonce'>,
  now: number = Date.now(),
): SignedPoolHeaders {
  const nonce = randomBytes(16).toString('base64url');
  const message = buildPoolMessage({ ...parts, timestampMs: now, nonce });
  const signature = edSign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url');
  return {
    [POOL_NODE_HEADER]: parts.senderNodeUuid,
    [POOL_PEER_HEADER]: parts.senderNodeFqdn,
    [POOL_TIMESTAMP_HEADER]: String(now),
    [POOL_NONCE_HEADER]: nonce,
    [POOL_SIGNATURE_HEADER]: `${POOL_SIGNATURE_PREFIX}${signature}`,
    [POOL_RECIPIENT_HEADER]: parts.recipientNodeUuid,
  };
}

export type PoolVerifyFailure =
  | 'missing_headers'
  | 'bad_signature_encoding'
  | 'bad_timestamp'
  | 'expired'
  | 'replayed'
  | 'nonce_cache_full'
  | 'bad_signature';

export type PoolVerifyResult = { ok: true } | { ok: false; reason: PoolVerifyFailure };

export interface PoolVerifyInput {
  method: string;
  path: string;
  senderNodeUuid: string;
  senderNodeFqdn: string;
  /** THIS node's UUID. A signature naming a different recipient must not verify here. */
  recipientNodeUuid: string;
  timestamp: string | null | undefined;
  nonce: string | null | undefined;
  signature: string | null | undefined;
  body: unknown;
  peerPublicKey: string;
}

/**
 * Verify a signed peer request, cheapest reject first so an unauthenticated flood never reaches the
 * ~50 µs curve operation. Every failure is reported as a reason for the log; the caller answers all
 * of them with the same 401, because telling a caller *which* check it failed is an oracle.
 */
export function verifyPoolSignature(input: PoolVerifyInput, nonces: PeerNonceCache, now: number = Date.now()): PoolVerifyResult {
  const { timestamp, nonce, signature } = input;
  if (!timestamp || !nonce || !signature) {
    return { ok: false, reason: 'missing_headers' };
  }
  if (!signature.startsWith(POOL_SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'bad_signature_encoding' };
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || !Number.isInteger(timestampMs)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  if (Math.abs(now - timestampMs) > PEER_SIGNATURE_SKEW_MS) {
    return { ok: false, reason: 'expired' };
  }

  // Recorded before the curve operation and keyed on the sender, so a replay is rejected even if
  // the signature would have verified — and so that a valid request can never be "spent" by an
  // attacker replaying its nonce first, which a global keyspace would allow.
  const remembered = nonces.remember(`${input.senderNodeUuid}:${nonce}`, timestampMs + PEER_SIGNATURE_SKEW_MS, now);
  if (remembered !== 'ok') {
    return { ok: false, reason: remembered === 'replay' ? 'replayed' : 'nonce_cache_full' };
  }

  let key: KeyObject;
  let signatureBytes: Buffer;
  try {
    key = publicKeyFromBase64(input.peerPublicKey);
    signatureBytes = Buffer.from(signature.slice(POOL_SIGNATURE_PREFIX.length), 'base64url');
  } catch {
    return { ok: false, reason: 'bad_signature_encoding' };
  }

  const message = buildPoolMessage({
    method: input.method,
    path: input.path,
    senderNodeUuid: input.senderNodeUuid,
    senderNodeFqdn: input.senderNodeFqdn,
    recipientNodeUuid: input.recipientNodeUuid,
    timestampMs,
    nonce,
    body: input.body,
  });

  let verified = false;
  try {
    verified = edVerify(null, Buffer.from(message, 'utf8'), key, signatureBytes);
  } catch {
    // A key of the wrong curve, or a malformed signature that got past the base64url decode.
    return { ok: false, reason: 'bad_signature' };
  }
  return verified ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/**
 * Bounded, single-use nonce memory.
 *
 * Fails CLOSED: once genuinely full of live entries it refuses rather than evicting a nonce that is
 * still inside its window, because evicting one is exactly what re-opens the replay it exists to
 * stop. Expired entries are dropped first, so "full" means real sustained load — at
 * {@link PEER_NONCE_CACHE_MAX} over the {@link PEER_SIGNATURE_SKEW_MS} window, an order of
 * magnitude more signed traffic than a pool of Hubs produces.
 *
 * Swept on its own short interval as well as on insert, so a burst followed by silence releases the
 * memory instead of holding it until the next request.
 */
export class PeerNonceCache {
  private readonly seen = new Map<string, number>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly max: number = PEER_NONCE_CACHE_MAX,
    private readonly sweepIntervalMs: number = PEER_NONCE_SWEEP_MS,
  ) {}

  remember(nonce: string, expiresAt: number, now: number = Date.now()): 'ok' | 'replay' | 'full' {
    if (this.seen.has(nonce)) {
      return 'replay';
    }
    if (this.seen.size >= this.max) {
      this.prune(now);
      if (this.seen.size >= this.max) {
        return 'full';
      }
    }
    this.seen.set(nonce, expiresAt);
    // Armed by the first nonce, not by module init. The overwhelming majority of Hubs have no pool
    // peer and therefore never reach this line, and a timer that only ever sweeps an empty map is a
    // cost every one of them would otherwise pay forever for a feature they do not use.
    this.startSweeper();
    return 'ok';
  }

  /**
   * Drop entries whose replay window has closed. Cheap, and the only thing the sweeper does.
   *
   * Disarms itself once the map is empty: with no entries there is nothing to expire, and the next
   * {@link remember} re-arms it. That is what keeps a Hub whose peers went quiet from holding a
   * timer open for the rest of the process's life.
   */
  prune(now: number = Date.now()): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(nonce);
      }
    }
    if (this.seen.size === 0) {
      this.stopSweeper();
    }
  }

  size(): number {
    return this.seen.size;
  }

  /** Whether the periodic sweep is currently armed. For tests that pin what a peerless Hub costs. */
  isSweeping(): boolean {
    return this.sweeper !== null;
  }

  /**
   * Start the periodic sweep. `unref()`d so it can never be the reason a process refuses to exit —
   * this cache is an optimisation over pruning on insert, not a service anything waits for.
   */
  startSweeper(intervalMs: number = this.sweepIntervalMs): void {
    if (this.sweeper) {
      return;
    }
    this.sweeper = setInterval(() => this.prune(), intervalMs);
    this.sweeper.unref?.();
  }

  stopSweeper(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }
}
