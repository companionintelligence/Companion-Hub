/**
 * What the guard SAYS when it refuses, which is the whole of what an operator gets to work with.
 *
 * A Hub that is registered but has no operator row used to answer SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN
 * to a valid, host-local device key. "Log in" is not the fix — there is nobody to log in as — and
 * acting on that sentence means going to look at the key, which is exactly what happened to twelve
 * of the sixteen Hub Pool nodes for a week. The distinction pinned here is the difference between a
 * diagnosable appliance and an undiagnosable one.
 */
import { HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslatableError } from '@/common/error/translatable-error';
import { AuthGuard } from '../auth.guard';

const contextFor = (request: Partial<Request>) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ method: 'GET', url: '/api/inference/pool/status', body: {}, ...request }) }),
  }) as unknown as ExecutionContext;

const keyOf = (error: unknown) => {
  const response = (error as TranslatableError).getResponse();
  return typeof response === 'object' && response ? (response as { message?: string }).message : String(response);
};

describe('AuthGuard', () => {
  let guard: AuthGuard;

  beforeEach(() => {
    guard = new AuthGuard({ debug: vi.fn() } as never);
  });

  it('admits a request that has a user', async () => {
    await expect(guard.canActivate(contextFor({ user: { id: 1, username: 'op@example.com' } as never }))).resolves.toBe(true);
  });

  it('answers 409 HUB_NOT_CLAIMED when a host-local credential found no operator', async () => {
    const error = await guard.canActivate(contextFor({ hubUnclaimed: true, hubPrincipal: 'portal-device' })).catch((err) => err);

    expect(error).toBeInstanceOf(TranslatableError);
    expect(keyOf(error)).toBe('AUTH_ERROR_HUB_NOT_CLAIMED');
    // 409, not 401: the request is well-formed and the credential is good. It is the server's state
    // that refuses, and that state has a remedy the caller can actually run (`cihub claim`).
    expect((error as TranslatableError).getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('still answers 401 to a caller who simply is not authenticated', async () => {
    const error = await guard.canActivate(contextFor({})).catch((err) => err);

    expect(keyOf(error)).toBe('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
    expect((error as TranslatableError).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });

  /**
   * A `qa:read` key is valid and narrow. "Log in" would send its holder to debug a key that works; the
   * true answer is that this route is not on the key's list. This is also the guard every operator
   * route uses, so it is what makes a new route closed to the key unless someone opens it on purpose.
   */
  it('answers 403 to a qa:read key on any route that uses it', async () => {
    // A GET: `AuthMiddleware` only resolves the key on a read, so a read is where this answer is given.
    const error = await guard
      .canActivate(contextFor({ hubPrincipal: 'qa-read', method: 'GET', url: '/api/inference/pool/settings' }))
      .catch((err) => err);

    expect(keyOf(error)).toBe('AUTH_ERROR_QA_READ_KEY_ROUTE_NOT_ALLOWED');
    expect((error as TranslatableError).getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('prefers the user over the unclaimed marker if both somehow arrive', async () => {
    // Belt and braces on the middleware's contract: the marker is set INSTEAD of a user, never
    // alongside one, and a request that has a principal must not be refused because of a flag.
    await expect(guard.canActivate(contextFor({ user: { id: 1 } as never, hubUnclaimed: true }))).resolves.toBe(true);
  });
});
