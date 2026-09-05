import { createZodDto } from '@/common/zod-dto';
import { z } from 'zod';

const pairPeerSchema = z.object({
  nodeFqdn: z.string().trim().min(1),
  displayName: z.string().trim().min(1).optional(),
});
export class PairPeerBody extends createZodDto(pairPeerSchema) {}

// ── Peer-to-peer wire bodies (no operator auth on `request`/`reject` — trust isn't established yet) ──

const incomingPairingRequestSchema = z.object({
  fromNodeFqdn: z.string().trim().min(1),
  fromDisplayName: z.string().trim().min(1).optional(),
  token: z.string().trim().min(32),
});
export class IncomingPairingRequestBody extends createZodDto(incomingPairingRequestSchema) {}

const pairingConfirmSchema = z.object({
  fromNodeFqdn: z.string().trim().min(1),
  token: z.string().trim().min(32),
});
export class PairingConfirmBody extends createZodDto(pairingConfirmSchema) {}

const pairingRejectSchema = z.object({
  fromNodeFqdn: z.string().trim().min(1),
});
export class PairingRejectBody extends createZodDto(pairingRejectSchema) {}
