import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { InternalNetworkGuard } from '../internal-network.guard';

function createContext(request: { ip?: string; socket?: { remoteAddress?: string }; headers?: Record<string, string> }): ExecutionContext {
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
