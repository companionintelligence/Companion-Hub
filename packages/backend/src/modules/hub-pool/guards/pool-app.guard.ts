import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { isPrivateOrLocalIp, normalizeIpLiteral } from '@/common/helpers/ip-address';
import { TUNNEL_MARKER_HEADERS } from '@/common/helpers/hub-pool';

/**
 * Proves an app-facing pool request originated inside the appliance.
 *
 * {@link InternalNetworkGuard} alone does not: behind Traefik / the Cloudflare
 * tunnel `request.ip` is the proxy's own private address unless `HUB_TRUST_PROXY`
 * is set, so it passes public tunnel traffic by default — and the Hub API is
 * unconditionally published through that tunnel. These routes spend real GPU
 * time, on this node and on every paired peer, so that is not an acceptable
 * default.
 *
 * Apps reach the proxy container-to-container at
 * `http://<hub>:<API_PORT>/api/inference/pool/...` (see `InferenceEndpointService`),
 * which traverses no proxy at all: a request carrying proxy provenance is by
 * definition not one of them, whatever `request.ip` says.
 *
 * This is an origin check, not caller authentication. The comparable app→Hub
 * routes pair {@link InternalNetworkGuard} with `ManagedAppKeyGuard`, but an app
 * that only declares `hub_integration.inference` is issued no managed key
 * (`hubTrustMaterialScopes` mints one only for an MCP client or a
 * provenance-gated first-party consumer) and the OpenAI/Ollama clients it uses
 * send `CI_LLM_API_KEY` — a backend key — in `Authorization`. Requiring a managed
 * key here would reject every pooled app.
 */
@Injectable()
export class PoolAppGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    for (const header of TUNNEL_MARKER_HEADERS) {
      if (request.headers[header]) {
        throw new ForbiddenException('The pool proxy is only available to apps on the local appliance network');
      }
    }

    // Every hop in a forwarded chain must itself be internal. The chain is caller-controlled, so
    // this can only ever reject — an internal caller could forge a clean one, but an internal
    // caller is already allowed.
    const forwardedFor = request.headers['x-forwarded-for'];
    const chain = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
    for (const hop of chain.split(',')) {
      const ip = normalizeIpLiteral(hop);
      if (ip && !isPrivateOrLocalIp(ip)) {
        throw new ForbiddenException('The pool proxy is only available to apps on the local appliance network');
      }
    }

    return true;
  }
}
