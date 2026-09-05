import { createHash, timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';

declare module 'express' {
  interface Request {
    poolPeer?: HubPoolPeer;
  }
}

/**
 * Verifies a peer-to-peer pool request. The caller identifies itself via
 * `X-Hub-Pool-Peer: <its own nodeFqdn>` and proves it with `Authorization:
 * Bearer <token>` — the token THIS Hub issued to that peer during pairing
 * (hashed and stored as `hub_pool_peer.verify_token_hash`). Attaches the
 * matched row to `request.poolPeer` for the handler.
 *
 * Deliberately does not itself require `status === 'connected'` — the
 * `/pair/confirm` handler needs to pass a still-`pending` row through this
 * same check. Handlers that require a fully connected peer (capabilities,
 * proxy routes) check `request.poolPeer.status` themselves.
 *
 * This is not a substitute for the tailnet being the primary network boundary
 * — it exists so that merely being *on* the tailnet doesn't imply a device may
 * call these routes; only a device this Hub has explicitly paired with can.
 */
@Injectable()
export class PoolPeerGuard implements CanActivate {
  constructor(private readonly repo: HubPoolPeerRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const nodeFqdn = request.header('x-hub-pool-peer');
    const authHeader = request.header('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;

    if (!nodeFqdn || !token) {
      throw new UnauthorizedException('Missing pool peer credentials');
    }

    const peer = await this.repo.findByNodeFqdn(nodeFqdn);
    if (!peer?.verifyTokenHash) {
      throw new UnauthorizedException('Unknown pool peer');
    }

    const presented = Buffer.from(createHash('sha256').update(token).digest('hex'));
    const expected = Buffer.from(peer.verifyTokenHash);
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw new UnauthorizedException('Invalid pool peer token');
    }

    request.poolPeer = peer;
    return true;
  }
}
