import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { McpApiKeyService } from './mcp-api-key.service';

@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(
    private readonly logger: LoggerService,
    private readonly apiKeys: McpApiKeyService,
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

    // SEC-MCP-8: the hashed, multi-key store is the sole authority (lookup by SHA-256; the 256-bit
    // key isn't brute-forceable, so no timing-safe compare is needed). We deliberately do NOT accept
    // the env MCP_API_KEY here as a break-glass fallback: env-helpers always derives a value for it,
    // so a live env compare would be a permanent credential no revoke could ever retire. The legacy
    // env key stays usable because bootstrap seeds it into this store as the "Default" key (revocable
    // like any other), and a wiped DB self-heals by reseeding that same derived value on next boot.
    if (await this.apiKeys.validate(token)) {
      return true;
    }

    this.logger.warn('MCP auth failure: invalid API key');
    throw new UnauthorizedException('Invalid API key');
  }
}
