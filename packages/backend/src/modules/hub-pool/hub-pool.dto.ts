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

const pairPeerSchema = z.object({
  nodeFqdn: peerFqdnSchema,
  displayName: z.string().trim().min(1).optional(),
});
export class PairPeerBody extends createZodDto(pairPeerSchema) {}

// ── Peer-to-peer wire bodies (no operator auth on `request` — trust isn't established yet) ──

const incomingPairingRequestSchema = z.object({
  fromNodeFqdn: peerFqdnSchema,
  fromDisplayName: z.string().trim().min(1).optional(),
  token: z.string().trim().min(32),
});
export class IncomingPairingRequestBody extends createZodDto(incomingPairingRequestSchema) {}

const pairingConfirmSchema = z.object({
  fromNodeFqdn: peerFqdnSchema,
  token: z.string().trim().min(32),
});
export class PairingConfirmBody extends createZodDto(pairingConfirmSchema) {}

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
  /** Queued-request head start the local node gets over a peer. 0 = pure least-loaded; higher = stickier to local. */
  poolLocalAffinity: z.number().int().min(MIN_POOL_LOCAL_AFFINITY).max(MAX_POOL_LOCAL_AFFINITY).optional(),
  /** Seconds between peer capability probes. Also sets how long a peer's snapshot stays trusted (three polls). */
  poolHealthPollSeconds: z.number().int().min(MIN_POOL_HEALTH_POLL_SECONDS).max(MAX_POOL_HEALTH_POLL_SECONDS).optional(),
});
export class UpdateHubPoolPreferencesBody extends createZodDto(hubPoolPreferencesSchema) {}

const routingLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ROUTING_LOG_CAPACITY).optional(),
});
export class RoutingLogQueryDto extends createZodDto(routingLogQuerySchema) {}
