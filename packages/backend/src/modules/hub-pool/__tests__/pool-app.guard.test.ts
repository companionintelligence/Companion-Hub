import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PoolAppGuard } from '../guards/pool-app.guard';

function createContext(headers: Record<string, string | string[]>, hubPrincipal?: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers, hubPrincipal }) }),
  } as ExecutionContext;
}

describe('PoolAppGuard', () => {
  const guard = new PoolAppGuard();

  it('allows a container-to-container call, which carries no proxy headers', () => {
    expect(guard.canActivate(createContext({ host: 'ci-hub:3000', 'content-type': 'application/json' }))).toBe(true);
  });

  it.each(['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'true-client-ip'])('rejects tunnel traffic marked by %s', (header) => {
    expect(() => guard.canActivate(createContext({ [header]: 'set' }))).toThrow(ForbiddenException);
  });

  /**
   * The key proves what provenance was standing in for, and an operator's editor is exactly the
   * caller that reaches this Hub through the tunnel. `AuthMiddleware` sets the principal only on
   * inference paths, so nothing else this guard protects is widened.
   */
  it('allows tunnel traffic once an inference API key has authenticated', () => {
    expect(guard.canActivate(createContext({ 'cf-ray': 'set', 'x-forwarded-for': '203.0.113.10' }, 'inference'))).toBe(true);
  });

  it.each(['portal-device', 'cli', 'qa-read'])('still rejects tunnel traffic for the %s principal', (principal) => {
    expect(() => guard.canActivate(createContext({ 'cf-ray': 'set' }, principal))).toThrow(ForbiddenException);
  });

  it('rejects a forwarded chain whose client hop is public', () => {
    expect(() => guard.canActivate(createContext({ 'x-forwarded-for': '203.0.113.10, 172.18.0.2' }))).toThrow(ForbiddenException);
  });

  it('rejects a public hop in a repeated x-forwarded-for header', () => {
    expect(() => guard.canActivate(createContext({ 'x-forwarded-for': ['172.18.0.2', '203.0.113.10'] }))).toThrow(ForbiddenException);
  });

  it('allows a wholly internal forwarded chain', () => {
    expect(guard.canActivate(createContext({ 'x-forwarded-for': '172.18.0.2, 100.101.102.103' }))).toBe(true);
  });
});
