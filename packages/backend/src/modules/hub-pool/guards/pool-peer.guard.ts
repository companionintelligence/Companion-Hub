import { createHash, timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable, type OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
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
  POOL_RECIPIENT_HEADER,
  POOL_REFUSAL_HEADER,
  POOL_REFUSAL_IDENTITY_MISMATCH,
  POOL_SIGNATURE_HEADER,
  POOL_TIMESTAMP_HEADER,
  verifyPoolSignature,
} from '../hub-pool-peer-auth';

declare module 'express' {
  interface Request {
    poolPeer?: HubPoolPeer;
  }
}

/**
 * One message for every rejection. Which check failed is a log line, never a response, with one
 * exception: a request addressed to a pool identity this node does not hold also gets
 * `X-Hub-Pool-Refusal: identity-mismatch` (see `POOL_REFUSAL_HEADER` for why that one is safe).
 */
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
export class PoolPeerGuard implements CanActivate, OnModuleDestroy {
  private readonly nonces = new PeerNonceCache();

  constructor(
    private readonly repo: HubPoolPeerRepository,
    private readonly identity: HubPoolIdentityService,
    private readonly configuration: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * There is deliberately no `onModuleInit` arming the nonce sweeper.
   *
   * The cache arms its own timer on the first nonce it stores and disarms it again once the last one
   * expires ({@link PeerNonceCache}), so a Hub with no pool peers — which is nearly all of them —
   * runs no interval for this guard at all, instead of sweeping an empty map every 30s forever.
   * `hasNonceSweeper()` exists so a test can pin that rather than the comment claiming it.
   */
  onModuleDestroy(): void {
    this.nonces.stopSweeper();
  }

  /** Whether this guard is currently holding a nonce-sweep timer. Test seam for the peerless-cost assertion. */
  hasNonceSweeper(): boolean {
    return this.nonces.isSweeping();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const claimedNodeUuid = request.header(POOL_NODE_HEADER)?.trim();
    const peer = claimedNodeUuid
      ? await this.admitSigned(request, claimedNodeUuid, (value) => setRefusalHeader(context, value))
      : await this.admitBearer(request);
    request.poolPeer = peer;
    return true;
  }

  private async admitSigned(request: Request, claimedNodeUuid: string, nameRefusal: (value: string) => void): Promise<HubPoolPeer> {
    // Only this node's own UUID is needed to verify — it is stored in the clear, so a Hub whose
    // private key has become undecryptable can still authenticate its peers even though it can no
    // longer sign. That asymmetry is what keeps a regenerated `.env` from taking a fleet down.
    const self = await this.identity.get();
    if (!self) {
      this.logger.warn('[HubPool] refusing a signed peer request: this node has no usable pool identity');
      throw new UnauthorizedException(REFUSED);
    }

    // Checked before the row lookup, because the case this exists for has no row: a node whose
    // database was recreated knows neither the sender nor the UUID the sender pinned for it. Without
    // this answer the sender sees a 401 it cannot tell from clock skew, and probes a node that will
    // never know it again. Doing that forever is what beta-max's peers did for 28 hours. Naming this
    // one refusal discloses nothing new; see `POOL_REFUSAL_HEADER`. An absent header is an older
    // sender and falls through to verification exactly as before.
    const addressedTo = request.header(POOL_RECIPIENT_HEADER)?.trim();
    if (addressedTo && addressedTo !== self.nodeUuid) {
      this.logger.warn(
        `[HubPool] refusing a signed request from ${normalizePeerFqdn(request.header('x-hub-pool-peer') ?? '') ?? 'an unnamed caller'}: it is addressed to pool identity ${addressedTo.slice(0, 64)}, which is not this node's. The caller paired with an earlier identity of this Hub and has to pair again.`,
      );
      nameRefusal(POOL_REFUSAL_IDENTITY_MISMATCH);
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

/**
 * Stamp {@link POOL_REFUSAL_HEADER} on the response before the guard throws. Headers set here
 * survive `MainExceptionFilter`, which rebuilds the body but writes to the same response.
 *
 * Best-effort: a context with no HTTP response (a unit-test double, a non-HTTP transport) still
 * refuses. It just refuses without naming why.
 */
function setRefusalHeader(context: ExecutionContext, value: string): void {
  try {
    const response = context.switchToHttp().getResponse<Response | undefined>();
    response?.setHeader?.(POOL_REFUSAL_HEADER, value);
  } catch {
    // No response to annotate. The 401 itself is unchanged.
  }
}

/** The path the sender signed: `originalUrl` where Express provides it, query stripped by {@link normalizePath}. */
function signedPathOf(request: Request): string {
  const raw = (request as { originalUrl?: string; url?: string; path?: string }).originalUrl ?? request.url ?? request.path ?? '';
  return normalizePath(raw);
}
