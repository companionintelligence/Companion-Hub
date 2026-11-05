import { type CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { DID_AUTH_FLAG } from './did-auth.service';

/**
 * Makes the DID sign-in routes absent while {@link DID_AUTH_FLAG} is off.
 *
 * It runs BEFORE `AuthGuard` on the routes that need a session, so a Hub that never turned the
 * feature on answers 404 to everyone, signed in or not: there is no surface to find, and nothing to
 * tell a caller that it exists. Read per call, like the service's own switch.
 */
@Injectable()
export class DidAuthFlagGuard implements CanActivate {
  canActivate(): boolean {
    if (process.env[DID_AUTH_FLAG] !== 'true') {
      throw new NotFoundException();
    }

    return true;
  }
}
