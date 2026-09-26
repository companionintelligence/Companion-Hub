import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { normalizeIpLiteral } from '@/common/helpers/ip-address';
import { internalOriginRefusal, type OriginCheckedRequest } from '@/common/helpers/request-origin';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { bootstrapAppNamesForSlug } from './bootstrap-app-names';

/** How long one slug's container addresses are reused before Docker is asked again. */
const ADDRESS_CACHE_TTL_MS = 15_000;

/**
 * Admit a bootstrap-handout request only from a container of the app the
 * `:slug` names.
 *
 * `GET /api/inference/apps/:slug/credentials*` hands an agent its inference
 * connection — which, when the Hub has fallen back to a cloud provider, is the
 * operator's own provider API key. The route accepts no credential by design:
 * the container fetching it has none yet. It was guarded by origin alone
 * (`InternalOriginGuard`: a private source address with no proxy provenance),
 * which every installed app container, every LAN device and every tailnet peer
 * satisfies — none of them needs to be the agent (2026-09-24 audit).
 *
 * This keeps that origin check as the outer layer and adds the binding the
 * route was missing: the source address must be one that a RUNNING container
 * of the slug's app currently holds, read from Docker. A neighbouring
 * container, a LAN host or a tailnet peer is refused because its address
 * belongs to nobody the slug names; an app that is not installed or not
 * running matches nothing and is refused too. No credential is introduced and
 * the agents' bootstrap scripts are unchanged.
 *
 * Addresses are cached per slug for a few seconds: the route is hit once per
 * container start, but a crash-looping agent must not turn into a Docker
 * listing per second.
 */
@Injectable()
export class AppContainerOriginGuard implements CanActivate {
  private readonly cache = new Map<string, { addresses: Set<string>; expiresAt: number }>();

  constructor(
    private readonly logger: LoggerService,
    private readonly dockerRead: DockerReadFacade,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<OriginCheckedRequest & { method?: string; originalUrl?: string; url?: string; params?: Record<string, string> }>();
    const where = `${request.method ?? ''} ${request.originalUrl ?? request.url ?? ''}`;

    const refusal = internalOriginRefusal(request);
    if (refusal !== null) {
      this.logger.warn(`[AppContainerOriginGuard] Refused ${where}: ${refusal}`);
      throw new ForbiddenException('This endpoint is only available to apps on the local appliance network');
    }

    const slug = request.params?.slug ?? '';
    const ip = normalizeIpLiteral(request.ip ?? request.socket?.remoteAddress);
    const addresses = await this.addressesFor(slug);
    if (ip && addresses.has(ip)) {
      return true;
    }

    // The address is logged (it is a Docker-network one, by the check above), never the body.
    this.logger.warn(`[AppContainerOriginGuard] Refused ${where}: ${ip ?? 'no address'} is not a running container of ${slug || '(no slug)'}`);
    throw new ForbiddenException('This endpoint is only available to the app it belongs to');
  }

  private async addressesFor(slug: string): Promise<Set<string>> {
    const now = Date.now();
    const cached = this.cache.get(slug);
    if (cached && cached.expiresAt > now) {
      return cached.addresses;
    }
    const addresses = await this.dockerRead.runningContainerAddressesForApps(bootstrapAppNamesForSlug(slug));
    this.cache.set(slug, { addresses, expiresAt: now + ADDRESS_CACHE_TTL_MS });
    return addresses;
  }
}
