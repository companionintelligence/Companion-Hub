import { TranslatableError } from '@/common/error/translatable-error';
import { type CanActivate, type ExecutionContext, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { DID_AUTH_FLAG } from './did-auth.service';
import { isCrossSiteBrowserRequest } from './portal-sso';
import { rawForwardedHost } from './utils/forward-auth-host';

/**
 * Makes the DID sign-in routes absent while {@link DID_AUTH_FLAG} is off.
 *
 * It runs BEFORE `AuthGuard` on the routes that need a session, so a Hub that never turned the
 * feature on answers 404 to everyone, signed in or not. Read per call, like the service's own switch.
 *
 * The answer is the one Nest gives for a path no route claims, byte for byte (the same message and
 * the same `path`, which the not-found handler reports relative to the global prefix), so a Hub with
 * the feature off cannot be told from a build that never had it. A test boots the same app without
 * these routes and compares the two, for HEAD, for absolute-form targets and for the other shapes
 * of request a scanner can send to the port.
 */
@Injectable()
export class DidAuthFlagGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (process.env[DID_AUTH_FLAG] === 'true') {
      return true;
    }

    throw absentRoute(context.switchToHttp().getRequest<Request>());
  }
}

/**
 * Refuses a request that is not JSON. A form (`application/x-www-form-urlencoded`) or `text/plain`
 * post is a CORS "simple" request: a page on any other origin can send one with the person's cookie
 * and no preflight, so the Hub's CORS policy is never consulted. A JSON post from another origin
 * needs a preflight, which the Hub answers only for its own origins. Requiring JSON is what moves the
 * request into that second case; it does not depend on any header a browser may leave out.
 */
@Injectable()
export class DidAuthJsonGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // `is` answers the type when the body is that type, `false` when it is another, `null` when there is no body.
    if (!context.switchToHttp().getRequest<Request>().is('application/json')) {
      throw new TranslatableError('AUTH_ERROR_DID_JSON_REQUIRED', undefined, HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    }

    return true;
  }
}

/**
 * Refuses a change a page on another origin sent with the person's cookie. Two independent signals:
 *
 * - `Sec-Fetch-Site: same-site | cross-site`. A browser sends it only to a potentially trustworthy
 *   URL (https, or a loopback address), so on a Hub reached over plain http at a LAN name or address
 *   the header is simply absent and this signal says nothing.
 * - An `Origin` that names another host or port. Browsers send it on every POST and DELETE, https or
 *   not, and a page on a sibling port or a sibling host is a different origin. This is the check that
 *   covers the plain-http case.
 *
 * A request with neither header (`curl`, the `cihub` CLI, a script) passes both: there is no browser
 * to be abused. So does a request whose `Origin` is this Hub's own, which is what its pages send.
 * The desktop shell's own origin (`tauri://localhost`) is another origin and is refused here until a
 * screen for these routes exists to be tested against it.
 */
@Injectable()
export class DidAuthSameOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (isCrossSiteBrowserRequest(request) || originNamesAnotherHost(request)) {
      throw new TranslatableError('AUTH_ERROR_DID_CROSS_SITE_REQUEST', undefined, HttpStatus.FORBIDDEN);
    }

    return true;
  }
}

/**
 * Whether a request that carries an `Origin` was sent from a page on a host or port other than the
 * one it was sent to. `null` (a sandboxed frame, a redirect across origins), a repeated header and
 * anything that is not a URL count as another host.
 *
 * "The host it was sent to" is the first `X-Forwarded-Host` value, as the proxy in front of the Hub
 * sets it, else `Host`. The port is kept: a page on the same machine at another port is another origin.
 * A default port written out on one side (`:443` on https) is the same as none on the other.
 */
export function originNamesAnotherHost(request: Request): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return false;
  }
  if (typeof origin !== 'string') {
    return true;
  }

  const own = rawForwardedHost(request.headers['x-forwarded-host']) || request.headers.host || '';
  if (!own) {
    return true;
  }

  try {
    const sent = new URL(origin);

    return new URL(`${sent.protocol}//${own}`).host.toLowerCase() !== sent.host.toLowerCase();
  } catch {
    return true;
  }
}

/**
 * The exception Nest's own not-found handler raises for this request, and the request state it
 * raises it in. That handler is mounted under the global prefix, so the exception filter's `path`
 * (`request.url`) is relative to it while the message carries the whole URL; a guard runs with the
 * whole URL in both. The DID routes sit at `<prefix>/auth/did/…`, which is where the prefix ends.
 *
 * Express keeps the scheme and host of an absolute-form target (`GET http://host/api/… HTTP/1.1`, what
 * a client sends through a forward proxy) when it strips a mount, so the path is `http://host/auth/did/…`
 * there, and this keeps them too. It reads them the way Express's router does: only when the target
 * does not start with `/`, and only when `://` comes before any `?`.
 */
export function absentRoute(request: Request): NotFoundException {
  const url = request.originalUrl;
  const protohost = protohostOf(url);
  const at = url.slice(protohost.length).search(/\/auth\/did\//i);
  if (at !== -1) {
    request.url = protohost + url.slice(protohost.length + at);
  }

  return new NotFoundException(`Cannot ${request.method} ${url}`);
}

/** The `scheme://host[:port]` an absolute-form request target starts with, or `''`. The router's `getProtohost`. */
function protohostOf(url: string): string {
  if (url.length === 0 || url[0] === '/') {
    return '';
  }

  const query = url.indexOf('?');
  const schemeEnd = url.slice(0, query === -1 ? url.length : query).indexOf('://');
  if (schemeEnd === -1) {
    return '';
  }

  return url.slice(0, Math.max(url.indexOf('/', schemeEnd + 3), 0));
}
