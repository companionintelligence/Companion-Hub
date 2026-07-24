import { type CanActivate, type ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyStoreUnavailableError } from '@/modules/api-keys/api-key.errors';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';

@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(
    private readonly logger: LoggerService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers?.authorization;

    if (!authHeader) {
      this.logger.warn('MCP auth failure: missing Authorization header');
      throw new UnauthorizedException('Missing Authorization header');
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      this.logger.warn('MCP auth failure: malformed Authorization header');
      throw new UnauthorizedException('Malformed Authorization header');
    }

    const token = parts[1] as string;

    // SEC-MCP-8: the hashed, multi-key store is the sole authority (lookup by SHA-256; a 256-bit key
    // isn't brute-forceable, so no timing-safe compare is needed). Deliberately NO env MCP_API_KEY
    // fallback — that value is derived from the appliance seed, so a live env compare would be a
    // credential no revoke could retire. Nothing seeds a key either: every key in the store was
    // created by an operator or provisioned to an app, and revoking one really retires it.
    // Scope-strict: only 'mcp'-scoped keys open the tool surface — an app-callback
    // key (HUB_APP_KEY, 'app' scope) can never call MCP tools.
    // #933: a key store outage (DNS to the DB flaking, Postgres restarting) is not an auth
    // verdict. Answer 503 so clients retry and operators look at infrastructure — a 401 here
    // sent both to the wrong place.
    let valid: boolean;
    try {
      valid = await this.apiKeys.validate(token, 'mcp');
    } catch (err) {
      if (err instanceof ApiKeyStoreUnavailableError) {
        this.logger.error('MCP auth unavailable: API key store unreachable', err.cause instanceof Error ? err.cause.message : '');
        throw new ServiceUnavailableException('Authentication temporarily unavailable — API key store unreachable');
      }
      throw err;
    }

    if (valid) {
      return true;
    }

    this.logger.warn('MCP auth failure: invalid API key');
    throw new UnauthorizedException('Invalid API key');
  }
}
