import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { isPrivateOrLocalIp, normalizeIpLiteral } from '@/common/helpers/ip-address';

/**
 * Best-effort defense-in-depth: allow only loopback / RFC1918 clients by source
 * IP.
 *
 * NOT a real trust boundary on its own. Behind Traefik / the Cloudflare tunnel,
 * `request.ip` is the proxy's own (private) address unless Express `trust proxy`
 * is configured (see `HUB_TRUST_PROXY` in main.ts), so by default this guard
 * PASSES for public tunnel traffic. The one route group that still carries it,
 * the memory-connect app callbacks, pairs it with `ManagedAppKeyGuard` (which
 * binds the presented managed key to the target app's URN), and that is the
 * authoritative check there. Every other app-facing route moved to an origin
 * check that also refuses tunnel markers and public forwarded hops
 * (`internalOriginRefusal`): `InferenceAccessGuard` where an `inference` API
 * key is an acceptable alternative, and {@link InternalOriginGuard} where no
 * credential is, such as the app credentials handout. Do not rely on this one
 * alone.
 */
@Injectable()
export class InternalNetworkGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest() as Request;
    const ip = normalizeIpLiteral(request.ip ?? request.socket.remoteAddress ?? undefined);
    if (!ip || !isPrivateOrLocalIp(ip)) {
      throw new ForbiddenException('This endpoint is only available on the local appliance network');
    }
    return true;
  }
}
