import { createHash, timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable, type OnModuleDestroy, type OnModuleInit, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { normalizePeerFqdn } from '@/common/helpers/hub-pool';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';
import { HubPoolIdentityService } from '../hub-pool-identity.service';
import {
  normalizePath,
  PeerNonceCache,
  POOL_NODE_HEADER,
  POOL_NONCE_HEADER,
  POOL_SIGNATURE_HEADER,
  POOL_TIMESTAMP_HEADER,
  verifyPoolSignature,
} from '../hub-pool-peer-auth';

declare module 'express' {
  interface Request {
    poolPeer?: HubPoolPeer;
  }
}

/** One message for every rejection. Which check failed is a log line, never a response. */
const REFUSED = 'Invalid pool peer credentials';

/**
 * Verifies a peer-to-peer pool request. Two branches, and which one runs is decided by whether the
 * caller sent `X-Hub-Pool-Node`.
 *
 * SIGNED (the branch this build prefers). The caller names its stable pool node UUID, and proves it
 * with an Ed25519 signature over method, path, its own UUID, its own claimed FQDN, THIS node's UUID,
 * a timestamp and a single-use nonce — plus a hash of the body on the control routes. The row is
 * found by UUID, so the verifier holds nothing but public data, and a rename does not break a
 * pairing.
 *
 * BEARER (legacy, byte-identical to the previous build). The caller identifies itself with
 * `X-Hub-Pool-Peer: <its own nodeFqdn>` and `Authorization: Bearer <token>` — the token THIS Hub
 * issued it at pairing, hashed into `hub_pool_peer.verify_token_hash`. Kept so a mixed-version
 * fleet keeps routing; refused for a row that has demonstrably moved to signatures (see
 * {@link bearerStillAccepted}) and refused outright when `poolRequireSignedPeers` is on.
 *
 * Deliberately does not itself require `status === 'connected'` — `/pair/confirm` needs a still
 * `pending` row to pass this same check. Handlers that require a connected peer check it themselves.
 *
 * WHAT THIS GUARD MUST NEVER DO: write `node_fqdn`. It is UNIQUE, so a rename that collides with
 * another row would turn an authenticated hot-path request into a 500, and a rewrite driven from
 * here would permanently redirect this Hub's outbound pool traffic on the strength of a header. A
 * verified name change is *recorded* here and acted on by the health tick, which can log a
 * collision instead of failing a request.
 */
@Injectable()
export class PoolPeerGuard implements CanActivate, OnModuleInit, OnModuleDestroy {
  private readonly nonces = new PeerNonceCache();

  constructor(
    private readonly repo: HubPoolPeerRepository,
    private readonly identity: HubPoolIdentityService,
    private readonly configuration: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  onModuleInit(): void {
    this.nonces.startSweeper();
  }

  onModuleDestroy(): void {
    this.nonces.stopSweeper();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const claimedNodeUuid = request.header(POOL_NODE_HEADER)?.trim();
    const peer = claimedNodeUuid ? await this.admitSigned(request, claimedNodeUuid) : await this.admitBearer(request);
    request.poolPeer = peer;
    return true;
  }

  private async admitSigned(request: Request, claimedNodeUuid: string): Promise<HubPoolPeer> {
    // Only this node's own UUID is needed to verify — it is stored in the clear, so a Hub whose
    // private key has become undecryptable can still authenticate its peers even though it can no
    // longer sign. That asymmetry is what keeps a regenerated `.env` from taking a fleet down.
    const self = await this.identity.get();
    if (!self) {
      this.logger.warn('[HubPool] refusing a signed peer request: this node has no usable pool identity');
      throw new UnauthorizedException(REFUSED);
    }

    const peer = await this.repo.findByNodeUuid(claimedNodeUuid);
    if (!peer?.peerPublicKey) {
      throw new UnauthorizedException(REFUSED);
    }

    const claimedFqdn = normalizePeerFqdn(request.header('x-hub-pool-peer') ?? '');
    if (!claimedFqdn) {
      throw new UnauthorizedException(REFUSED);
    }

    const result = verifyPoolSignature(
      {
        method: request.method,
        path: signedPathOf(request),
        senderNodeUuid: claimedNodeUuid,
        senderNodeFqdn: claimedFqdn,
        recipientNodeUuid: self.nodeUuid,
        timestamp: request.header(POOL_TIMESTAMP_HEADER),
        nonce: request.header(POOL_NONCE_HEADER),
        signature: request.header(POOL_SIGNATURE_HEADER),
        body: (request as { body?: unknown }).body,
        peerPublicKey: peer.peerPublicKey,
      },
      this.nonces,
    );
    if (!result.ok) {
      this.logger.warn(`[HubPool] refusing a signed request from ${peer.nodeFqdn}: ${result.reason}`);
      throw new UnauthorizedException(REFUSED);
    }

    // Identity beats address: the name is now authenticated, so a change means the peer MOVED.
    // Recorded, not written — see the class comment.
    if (claimedFqdn !== peer.nodeFqdn) {
      this.identity.noteObservedPeerFqdn(peer.id, claimedFqdn);
    }

    // The evidence that closes the bearer window. Written at most once per upgrade rather than on
    // every request: `signedSeenAt` only ever goes from null to set, and `bearerGraceUntil` only
    // ever gets cleared, so once both are settled this branch stops touching the database entirely.
    if (!peer.signedSeenAt || peer.bearerGraceUntil) {
      const observedAt = new Date().toISOString();
      await this.repo.update(peer.id, { signedSeenAt: observedAt, bearerGraceUntil: null });
      return { ...peer, signedSeenAt: observedAt, bearerGraceUntil: null };
    }
    return peer;
  }

  private async admitBearer(request: Request): Promise<HubPoolPeer> {
    // Canonicalized the same way rows are stored, so a peer that spells its own name differently
    // (trailing dot, mixed case) still resolves — and a header that isn't a hostname never reaches
    // the lookup at all.
    const nodeFqdn = normalizePeerFqdn(request.header('x-hub-pool-peer') ?? '');
    const authHeader = request.header('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;

    if (!nodeFqdn || !token) {
      throw new UnauthorizedException('Missing pool peer credentials');
    }

    if (this.configuration.getHubPoolPreferences().poolRequireSignedPeers) {
      this.logger.warn(`[HubPool] refusing a bearer-authenticated request from ${nodeFqdn}: this node requires signed peers`);
      throw new UnauthorizedException(REFUSED);
    }

    const peer = await this.repo.findByNodeFqdn(nodeFqdn);
    if (!peer?.verifyTokenHash) {
      throw new UnauthorizedException('Unknown pool peer');
    }

    if (!bearerStillAccepted(peer)) {
      this.logger.warn(`[HubPool] refusing a bearer token from ${peer.nodeFqdn}: it has already been observed signing its requests`);
      throw new UnauthorizedException(REFUSED);
    }

    const presented = Buffer.from(createHash('sha256').update(token).digest('hex'));
    const expected = Buffer.from(peer.verifyTokenHash);
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw new UnauthorizedException('Invalid pool peer token');
    }

    return peer;
  }
}

/**
 * The no-downgrade rule.
 *
 * A peer whose key we have pinned AND which we have actually seen sign a request may not fall back
 * to the bearer token: the token columns are nulled on the very next health tick, so continuing to
 * honour one would keep a dormant secret alive for no reason.
 *
 * Crucially the trigger is *observed evidence*, not a clock. Refusing on `bearerGraceUntil` alone
 * would strand any pairing where the upgrade landed on one side and not the other — the peer would
 * still be presenting a bearer token, and the window would close under it with no recovery path.
 * `bearerGraceUntil` bounds how long this node waits for that evidence before the health tick
 * rolls the pinning back and retries; it is not itself the refusal.
 */
export function bearerStillAccepted(peer: HubPoolPeer): boolean {
  return !(peer.peerPublicKey && peer.signedSeenAt);
}

/** The path the sender signed: `originalUrl` where Express provides it, query stripped by {@link normalizePath}. */
function signedPathOf(request: Request): string {
  const raw = (request as { originalUrl?: string; url?: string; path?: string }).originalUrl ?? request.url ?? request.path ?? '';
  return normalizePath(raw);
}
