import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { LoggerService } from '@/core/logger/logger.service';

/**
 * Authorizes a wrapper -> Hub call by the calling app's own managed key
 * (`HUB_APP_KEY`, or the legacy `HUB_MCP_API_KEY`, injected into the container),
 * and binds it to the app in the route: the key must resolve to
 * `ownerAppUrn === :urn`. This replaces source-IP trust as the authorization for
 * the per-app state/skip endpoints — a different app (or any container on the
 * shared network) cannot read or mutate another app's memory-connect state, only
 * its own.
 *
 * Both the 'app' and 'mcp' scopes are accepted: 'app' is the canonical callback
 * scope, while 'mcp' covers managed keys minted before the scopes migration
 * (their rows upgrade to ['mcp','app'] on the app's next env regeneration).
 * Tightening to 'app'-only is a follow-up once the fleet has converged.
 */
@Injectable()
export class ManagedAppKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly logger: LoggerService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const header = req.headers.authorization;
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const rawKey = bearer || (req.get('x-api-key') ?? '');

    const ownerAppUrn = await this.apiKeys.resolveManagedAppUrn(rawKey, ['app', 'mcp']);
    // Express has already URL-decoded the route param, so decoding again is
    // normally a no-op; do it inside try/catch so a malformed `%` sequence yields
    // a mismatch (401) rather than an unhandled URIError → 500.
    const urnParam = req.params.urn;
    const raw = typeof urnParam === 'string' ? urnParam : '';
    let targetUrn: string;
    try {
      targetUrn = decodeURIComponent(raw);
    } catch {
      targetUrn = raw;
    }

    if (!ownerAppUrn || ownerAppUrn !== targetUrn) {
      // Log the reason only — never the presented key. Low volume: wrappers hit
      // these endpoints on page navigations, and rejections mean misconfiguration.
      this.logger.warn(
        '[ManagedAppKeyGuard] rejected app-callback key for',
        targetUrn || '(no urn)',
        ownerAppUrn ? '(owner mismatch)' : '(unresolved key)',
      );
      throw new UnauthorizedException('Invalid or mismatched app key');
    }

    return true;
  }
}
