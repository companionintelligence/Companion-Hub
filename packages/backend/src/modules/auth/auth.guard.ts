import { TranslatableError } from '@/common/error/translatable-error';
import { LoggerService } from '@/core/logger/logger.service';
import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
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
      // A `qa:read` key is valid and deliberately narrow, and this route is not on its list. "Log in"
      // would send whoever holds it to debug a key that works; 403 says the route is the problem.
      // Only `ObservabilityReadGuard` admits it, on handlers marked `@ObservabilityRead()`.
      if (request.hubPrincipal === 'qa-read') {
        throw new TranslatableError('AUTH_ERROR_QA_READ_KEY_ROUTE_NOT_ALLOWED', undefined, HttpStatus.FORBIDDEN);
      }

      // "Log in" is not the fix when the caller already presented a valid host-local credential and
      // this Hub simply has no operator to be. Saying so cost the Hub Pool fleet a week: twelve
      // nodes answering 401 to a correct device key were all read as key failures, and the keys
      // were fine. 409 CONFLICT, because the request is well-formed and the server's state is what
      // refuses it — clear it with `cihub claim`.
      if (request.hubUnclaimed) {
        throw new TranslatableError('AUTH_ERROR_HUB_NOT_CLAIMED', undefined, HttpStatus.CONFLICT);
      }

      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN', undefined, HttpStatus.UNAUTHORIZED);
    }

    return true;
  }
}
