import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { LoggerService } from '@/core/logger/logger.service';

@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(private readonly logger: LoggerService) {}

  canActivate(context: ExecutionContext): boolean {
    const apiKey = process.env.MCP_API_KEY;
    if (!apiKey) {
      throw new UnauthorizedException('MCP_API_KEY is not configured');
    }

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
    const tokenBuffer = Buffer.from(token);
    const keyBuffer = Buffer.from(apiKey);
    if (tokenBuffer.length !== keyBuffer.length || !timingSafeEqual(tokenBuffer, keyBuffer)) {
      this.logger.warn('MCP auth failure: invalid API key');
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
