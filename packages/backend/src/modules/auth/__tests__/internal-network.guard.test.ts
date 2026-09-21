import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { InternalNetworkGuard } from '../internal-network.guard';

function createContext(request: {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string>;
  hubPrincipal?: string;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
}

describe('InternalNetworkGuard', () => {
  const guard = new InternalNetworkGuard();

  it('allows loopback requests', () => {
    expect(
      guard.canActivate(
        createContext({
          ip: '127.0.0.1',
          socket: { remoteAddress: '203.0.113.10' },
        }),
      ),
    ).toBe(true);
  });

  it('allows IPv6-mapped private addresses resolved by Nest/Express', () => {
    expect(
      guard.canActivate(
        createContext({
          ip: '::ffff:192.168.1.25',
        }),
      ),
    ).toBe(true);
  });

  it('falls back to the socket remote address when request.ip is unavailable', () => {
    expect(
      guard.canActivate(
        createContext({
          socket: { remoteAddress: '::ffff:10.0.0.42' },
        }),
      ),
    ).toBe(true);
  });

  it('allows tailnet clients (Tailscale CGNAT range)', () => {
    expect(guard.canActivate(createContext({ ip: '100.101.102.103' }))).toBe(true);
  });

  it('rejects public client addresses', () => {
    expect(() =>
      guard.canActivate(
        createContext({
          ip: '203.0.113.10',
          socket: { remoteAddress: '203.0.113.10' },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  /**
   * An authenticated `inference` key answers the question this guard asks better than the source IP
   * does. The principal is set only on inference paths (`AuthMiddleware.attachInferenceKey`), so it
   * cannot appear on the other routes this guard protects.
   */
  it('allows a public address once an inference API key has authenticated', () => {
    expect(
      guard.canActivate(
        createContext({
          ip: '203.0.113.10',
          socket: { remoteAddress: '203.0.113.10' },
          hubPrincipal: 'inference',
        }),
      ),
    ).toBe(true);
  });

  it.each(['session', 'portal-device', 'cli', 'qa-read'])('still rejects a public address for the %s principal', (principal) => {
    expect(() => guard.canActivate(createContext({ ip: '203.0.113.10', hubPrincipal: principal }))).toThrow(ForbiddenException);
  });

  it('does not trust spoofed x-forwarded-for headers directly', () => {
    expect(() =>
      guard.canActivate(
        createContext({
          ip: '203.0.113.10',
          socket: { remoteAddress: '203.0.113.10' },
          headers: { 'x-forwarded-for': '127.0.0.1' },
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});
