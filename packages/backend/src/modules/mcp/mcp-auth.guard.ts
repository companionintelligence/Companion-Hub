import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
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

    // SEC-MCP-8: primary path — match against the hashed, multi-key store (lookup by SHA-256; the
    // 256-bit key isn't brute-forceable, so no timing-safe compare is needed for the DB path).
    if (await this.apiKeys.validate(token)) {
      return true;
    }

    // Break-glass fallback: the env MCP_API_KEY is still accepted so operators can always recover
    // (e.g. the DB was wiped/reseeded). Constant-time compared and logged so it's auditable.
    const envKey = process.env.MCP_API_KEY;
    if (envKey && this.constantTimeEqual(token, envKey)) {
      this.logger.warn('MCP auth via break-glass env MCP_API_KEY (no matching stored key)');
      return true;
    }

    this.logger.warn('MCP auth failure: invalid API key');
    throw new UnauthorizedException('Invalid API key');
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
  }
}
