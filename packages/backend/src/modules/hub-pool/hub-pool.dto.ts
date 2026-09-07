import { createZodDto } from '@/common/zod-dto';
import {
  MAX_POOL_HEALTH_POLL_SECONDS,
  MAX_POOL_LOCAL_AFFINITY,
  MIN_POOL_HEALTH_POLL_SECONDS,
  MIN_POOL_LOCAL_AFFINITY,
  normalizePeerFqdn,
} from '@/common/helpers/hub-pool';
import { ROUTING_LOG_CAPACITY } from './hub-pool-routing-log.service';
import { z } from 'zod';

/**
 * A peer FQDN is interpolated into `https://<fqdn>/api/...` on every handshake
 * call, so the shape is validated at the edge rather than only where it is used.
 * `HubPoolPeerService` re-checks it — this is the 400, not the trust boundary.
 */
const peerFqdnSchema = z
  .string()
  .trim()
  .refine((value) => normalizePeerFqdn(value) !== null, { message: 'Must be a bare hostname (no scheme, credentials, port, path or IP literal)' });

/** Exactly six digits. Never trimmed to a number: a PIN can legitimately start with a zero. */
const pairingPinSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, { message: 'A pairing PIN is six digits' });

/**
 * A peer's Ed25519 public key on the wire: base64 SPKI DER, which for Ed25519 is always 44 base64
 * characters. Bounded here so a caller cannot post a megabyte of "key" at an unauthenticated route.
 */
const peerPublicKeySchema = z.string().trim().min(32).max(256);

/** A pool node UUID as it appears in a body. `.uuid()` because the column is `uuid`, and a non-UUID could never match a row. */
const peerNodeUuidSchema = z.uuid();

const pairPeerSchema = z.object({
  nodeFqdn: peerFqdnSchema,
  displayName: z.string().trim().min(1).optional(),
  /**
   * The PIN minted on the peer's own screen. Optional: without it this is the pre-existing
   * request/approve flow, unchanged, which is what keeps a mixed-version fleet pairing at all.
   */
  pin: pairingPinSchema.optional(),
});
export class PairPeerBody extends createZodDto(pairPeerSchema) {}

// ── Peer-to-peer wire bodies (no operator auth on `request` — trust isn't established yet) ──

const incomingPairingRequestSchema = z.object({
  fromNodeFqdn: peerFqdnSchema,
  fromDisplayName: z.string().trim().min(1).optional(),
  token: z.string().trim().min(32),
  /**
   * The identity fields are `.optional()` and must stay that way: a byte-for-byte protocol-1 body
   * carries none of them and has to keep parsing into today's pending row. They are only ever
   * stored when `pin` came with them and verified — an unauthenticated identity claim is exactly
   * the anonymous write the PIN closes.
   */
  fromNodeUuid: peerNodeUuidSchema.optional(),
  fromPublicKey: peerPublicKeySchema.optional(),
  pin: pairingPinSchema.optional(),
});
export class IncomingPairingRequestBody extends createZodDto(incomingPairingRequestSchema) {}

const pairingConfirmSchema = z.object({
  fromNodeFqdn: peerFqdnSchema,
  token: z.string().trim().min(32),
  /** Optional for the same reason as above — a protocol-1 peer's confirm body has neither field. */
  fromNodeUuid: peerNodeUuidSchema.optional(),
  fromPublicKey: peerPublicKeySchema.optional(),
});
export class PairingConfirmBody extends createZodDto(pairingConfirmSchema) {}

/**
 * `POST /pair/upgrade`: the bearer→signed exchange, authenticated by `PoolPeerGuard` with the very
 * credential it retires. Both fields are required here — unlike the two bodies above, this route
 * exists only to carry them.
 */
const pairingUpgradeSchema = z.object({
  nodeUuid: peerNodeUuidSchema,
  publicKey: peerPublicKeySchema,
});
export class PairingUpgradeBody extends createZodDto(pairingUpgradeSchema) {}

// ── Operator-editable pool settings ──

/**
 * Every field is optional and omitting one leaves it unchanged, so the settings card can PATCH a
 * single toggle without having to round-trip and resend the rest. Bounds are enforced here, on the
 * write path, rather than on `settingsSchema` — that schema also parses settings.json at boot,
 * where an out-of-range persisted value must degrade to the default instead of failing the parse.
 */
const hubPoolPreferencesSchema = z.object({
  /**
   * The in-product kill switch. `HUB_POOL_USER_DISABLED=true` in the environment still overrides
   * it, and `GET /inference/pool/status` reports which of the two is in force.
   */
  poolEnabled: z.boolean().optional(),
  /**
   * Stop sending work TO peers. Apps here are then served by this node's own engines, and get the
   * existing actionable 502 when it cannot serve the model — the request is never shipped out.
   * `HUB_POOL_OUTBOUND_DISABLED=true` in the environment still overrides it.
   */
  poolOutboundEnabled: z.boolean().optional(),
  /**
   * Stop serving work FOR peers, while still using them. Peers see a healthy node advertising an
   * empty inventory and `acceptingWork: false`, not an unreachable one — this is "not right now",
   * not "I have left the pool", which is what the master switch means.
   * `HUB_POOL_INBOUND_DISABLED=true` in the environment still overrides it.
   */
  poolInboundEnabled: z.boolean().optional(),
  /** Queued-request head start the local node gets over a peer. 0 = least-loaded (local still wins an exact tie); higher = stickier to local. */
  poolLocalAffinity: z.number().int().min(MIN_POOL_LOCAL_AFFINITY).max(MAX_POOL_LOCAL_AFFINITY).optional(),
  /** Seconds between peer capability probes. Also sets how long a peer's snapshot stays trusted (three polls). */
  poolHealthPollSeconds: z.number().int().min(MIN_POOL_HEALTH_POLL_SECONDS).max(MAX_POOL_HEALTH_POLL_SECONDS).optional(),
  /**
   * Refuse the legacy bearer token outright, in both directions. The explicit no-downgrade switch;
   * turning it on before every peer reports `authMode: 'signed'` is an outage, which is why it is
   * the one pool flag that defaults off rather than on.
   */
  poolRequireSignedPeers: z.boolean().optional(),
});
export class UpdateHubPoolPreferencesBody extends createZodDto(hubPoolPreferencesSchema) {}

const routingLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ROUTING_LOG_CAPACITY).optional(),
});
export class RoutingLogQueryDto extends createZodDto(routingLogQuerySchema) {}
