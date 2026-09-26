import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { internalOriginRefusal, type OriginCheckedRequest } from '@/common/helpers/request-origin';
import { LoggerService } from '@/core/logger/logger.service';

/**
 * Admit a request only when it provably originated inside the appliance — no credential leg.
 *
 * For routes that are app-only and hand out material an app needs before it has any credential of
 * its own. The bootstrap handout (`GET /api/inference/apps/:slug/credentials*`, which CI-OpenClaw
 * and CI-Hermes fetch at container start, and whose body can carry a configured cloud provider's
 * API key) now sits behind `AppContainerOriginGuard`, which runs this same check and then also
 * requires the source address to belong to a running container of the slug's app. Apps reach
 * those routes container-to-container, which traverses no proxy, so a request carrying proxy
 * provenance is not one of them. {@link InternalNetworkGuard} alone let such a request through:
 * behind the Cloudflare tunnel `request.ip` is the proxy's own private address unless
 * `HUB_TRUST_PROXY` is set, and a registered Hub publishes its whole API through that tunnel with
 * no middleware, so the credentials handout was answerable from the public internet.
 *
 * `internalOriginRefusal` makes the three checks (private resolved address, no tunnel marker, no
 * public forwarded hop). Deliberately NO API-key alternative: an operator key on these routes would
 * turn a leaked key into every app's backend credentials, and the apps that fetch them are issued
 * no managed key to present in the first place. A caller outside the appliance that needs
 * inference uses an `inference`-scoped key on the routes {@link InferenceAccessGuard} admits,
 * never this one.
 *
 * The log names the path and the refusal reason, never the body it would have served.
 */
@Injectable()
export class InternalOriginGuard implements CanActivate {
  constructor(private readonly logger: LoggerService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<OriginCheckedRequest & { method?: string; originalUrl?: string; url?: string }>();

    const refusal = internalOriginRefusal(request);
    if (refusal === null) {
      return true;
    }

    // Low volume: apps fetch these once per container start, so a refusal means an app (or a
    // scanner) reached the Hub through its public hostname instead of the Docker network.
    this.logger.warn(`[InternalOriginGuard] Refused ${request.method ?? ''} ${request.originalUrl ?? request.url ?? ''}: ${refusal}`);
    throw new ForbiddenException('This endpoint is only available to apps on the local appliance network');
  }
}
