import { HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { TranslatableError } from '@/common/error/translatable-error';
import { HubSessionGuard } from '../hub-session.guard';

const contextFor = (request: Partial<Request>) =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const refusalOf = (request: Partial<Request>) => {
  try {
    new HubSessionGuard().canActivate(contextFor(request));
  } catch (error) {
    return error as TranslatableError;
  }
  throw new Error('expected the guard to refuse');
};

const operator = { id: 1, username: 'op@example.com', operator: true } as never;

describe('HubSessionGuard', () => {
  it('admits a person signed in with a Hub session', () => {
    expect(new HubSessionGuard().canActivate(contextFor({ hubPrincipal: 'session', user: operator }))).toBe(true);
  });

  it('refuses the Portal device key, even though it speaks as the first operator', () => {
    // First-party Memory holds this key, so it must not be able to unpair the Hub.
    const error = refusalOf({ hubPrincipal: 'portal-device', user: operator });

    expect(error).toBeInstanceOf(TranslatableError);
    expect((error.getResponse() as { message: string }).message).toBe('AUTH_ERROR_SIGNED_IN_PERSON_REQUIRED');
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('refuses the CLI JWT', () => {
    expect(refusalOf({ hubPrincipal: 'cli', user: operator }).getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('refuses a caller that names no principal, such as an app or MCP key', () => {
    // App and MCP keys are resolved by their own guards and never set `hubPrincipal`. A user placed
    // on the request by anything but the session arm must not pass for a person.
    expect(refusalOf({ user: operator }).getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(refusalOf({}).getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('refuses a session principal with no user behind it', () => {
    expect(refusalOf({ hubPrincipal: 'session' }).getStatus()).toBe(HttpStatus.FORBIDDEN);
  });
});
