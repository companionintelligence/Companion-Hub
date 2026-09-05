import { createZodDto } from '@/common/zod-dto';
import { normalizePeerFqdn } from '@/common/helpers/hub-pool';
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
