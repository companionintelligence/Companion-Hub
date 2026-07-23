import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
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
    // fallback — that value is always derived, so a live env compare would be a credential no revoke
    // could retire. How the env key enters the store: see ApiKeyService.seedDefaultKeyIfEmpty.
    // Scope-strict: only 'mcp'-scoped keys open the tool surface — an app-callback
    // key (HUB_APP_KEY, 'app' scope) can never call MCP tools.
    if (await this.apiKeys.validate(token, 'mcp')) {
      return true;
    }

    this.logger.warn('MCP auth failure: invalid API key');
    throw new UnauthorizedException('Invalid API key');
  }
}
