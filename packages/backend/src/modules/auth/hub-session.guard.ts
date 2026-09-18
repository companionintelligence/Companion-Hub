import { TranslatableError } from '@/common/error/translatable-error';
import { hubSessionOperatorUserId } from '@/core/portal/hub-session-operator';
import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Admits only a person signed in to this Hub with a session.
 *
 * Use it after `AuthGuard`, so a caller with no credential still gets 401. It refuses every
 * credential that is not a person: the Portal device key (which first-party Memory also holds),
 * the CLI JWT, and app or MCP keys, none of which name a session principal. Routes that clear this
 * Hub's registration need it, because that decision belongs to a person, not to software running
 * next to the Hub.
 */
@Injectable()
export class HubSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (hubSessionOperatorUserId(request) === undefined) {
      throw new TranslatableError('AUTH_ERROR_SIGNED_IN_PERSON_REQUIRED', undefined, HttpStatus.FORBIDDEN);
    }

    return true;
  }
}
