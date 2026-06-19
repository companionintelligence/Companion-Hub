import { LoggerService } from '@/core/logger/logger.service';
import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

const SENSITIVE_BODY_KEYS = new Set(['password', 'currentPassword', 'newPassword', 'token', 'api_key', 'apiKey', 'secret']);

function redactRequestBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_BODY_KEYS.has(key) ? '[redacted]' : value;
  }
  return redacted;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly logger: LoggerService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest() as Request;

    this.logger.debug('HTTP request', request.method, request.url, redactRequestBody(request.body));

    if (!request.user) {
      throw new UnauthorizedException();
    }

    return true;
  }
}
