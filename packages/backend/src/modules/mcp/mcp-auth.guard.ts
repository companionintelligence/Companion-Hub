import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class McpAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const apiKey = process.env.MCP_API_KEY;
    if (!apiKey) {
      throw new UnauthorizedException('MCP_API_KEY is not configured');
    }

    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers?.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      throw new UnauthorizedException('Malformed Authorization header');
    }

    if (parts[1] !== apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
