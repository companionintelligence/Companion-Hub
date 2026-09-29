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
 * listing per second. The cache is only trusted to ADMIT, never to refuse:
 * an app's containers start a few hundred milliseconds apart, so a set read
 * when the first one asked can lack the second one's address (core-2,
 * 2026-09-29: ci-hermes's gateway cached the set ~100 ms before the agent
 * container had its IP, and the agent's handout 260 ms later was refused —
 * its curl does not retry a 403). An address the cached set lacks is
 * therefore checked against Docker again before it is refused, and an empty
 * result (nothing running yet, or Docker unreadable) is never cached.
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
    if (ip && (await this.isRunningContainerOf(slug, ip))) {
      return true;
    }

    // The address is logged (it is a Docker-network one, by the check above), never the body.
    this.logger.warn(`[AppContainerOriginGuard] Refused ${where}: ${ip ?? 'no address'} is not a running container of ${slug || '(no slug)'}`);
    throw new ForbiddenException('This endpoint is only available to the app it belongs to');
  }

  /**
   * A cached hit admits without asking Docker. A miss — no fresh entry, or a
   * fresh entry without this address — asks Docker once, so every request
   * costs at most one listing and an admitted one within the TTL costs none.
   *
   * A refused request therefore costs one listing each time, which is
   * deliberately not rate-limited: any cooldown long enough to matter would
   * reopen the race above (the second container asks within a second of the
   * first). It is bounded instead by what reaches this point: callers that
   * already passed the internal-origin check (private address, no proxy
   * provenance), for a known slug only (an unknown one maps to no app names
   * and never reaches Docker), and the listing is one label-filtered call on
   * the local socket under a timeout — the same cost as a cold cache.
   */
  private async isRunningContainerOf(slug: string, ip: string): Promise<boolean> {
    const cached = this.cache.get(slug);
    if (cached && cached.expiresAt > Date.now() && cached.addresses.has(ip)) {
      return true;
    }
    const addresses = await this.dockerRead.runningContainerAddressesForApps(bootstrapAppNamesForSlug(slug));
    if (addresses.size > 0) {
      this.cache.set(slug, { addresses, expiresAt: Date.now() + ADDRESS_CACHE_TTL_MS });
    } else {
      // Nothing running now (or Docker unreadable): drop any older set rather than admit from it.
      this.cache.delete(slug);
    }
    return addresses.has(ip);
  }
}
