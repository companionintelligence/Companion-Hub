import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalOriginGuard } from '../internal-origin.guard';

function createContext(request: {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[]>;
  method?: string;
  originalUrl?: string;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
}

/**
 * The credentials handout is app-only and the apps fetch it container-to-container, so the guard
 * must admit a bare Docker-bridge request and refuse anything that arrived through a proxy — the
 * traffic `InternalNetworkGuard` passed because behind the tunnel `request.ip` is the proxy's own
 * private address.
 */
describe('InternalOriginGuard', () => {
  const logger = { warn: vi.fn() };
  const guard = new InternalOriginGuard(logger as never);

  beforeEach(() => {
    logger.warn.mockClear();
  });

  it('admits a container-to-container call: a Docker-bridge address and no proxy headers', () => {
    expect(
      guard.canActivate(
        createContext({
          ip: '172.18.0.2',
          headers: { host: 'ci-hub:5002', 'user-agent': 'curl/8.5.0' },
        }),
      ),
    ).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('admits loopback, an IPv6-mapped private address, and a tailnet (CGNAT) address', () => {
    expect(guard.canActivate(createContext({ ip: '127.0.0.1', headers: {} }))).toBe(true);
    expect(guard.canActivate(createContext({ ip: '::ffff:192.168.1.25', headers: {} }))).toBe(true);
    expect(guard.canActivate(createContext({ ip: '100.101.102.103', headers: {} }))).toBe(true);
  });

  it('falls back to the socket remote address when request.ip is unavailable', () => {
    expect(guard.canActivate(createContext({ socket: { remoteAddress: '::ffff:10.0.0.42' }, headers: {} }))).toBe(true);
  });

  it('refuses a public client address, whatever the headers say', () => {
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

  it('refuses a request with no address it can read', () => {
    expect(() => guard.canActivate(createContext({ headers: {} }))).toThrow(ForbiddenException);
  });

  /**
   * Behind the tunnel the resolved address is the proxy's own private one, so only the marker the
   * edge adds says the caller is not inside. A caller cannot strip it.
   */
  it.each([
    'cf-ray',
    'cf-connecting-ip',
    'cf-visitor',
    'true-client-ip',
  ])('refuses tunnel traffic marked by %s even from a private proxy address', (header) => {
    expect(() => guard.canActivate(createContext({ ip: '172.18.0.2', headers: { [header]: 'set' } }))).toThrow(ForbiddenException);
  });

  it('refuses a forwarded chain whose client hop is public', () => {
    expect(() => guard.canActivate(createContext({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '203.0.113.10, 172.18.0.2' } }))).toThrow(
      ForbiddenException,
    );
  });

  it('refuses a public hop in a repeated x-forwarded-for header', () => {
    expect(() => guard.canActivate(createContext({ ip: '172.18.0.2', headers: { 'x-forwarded-for': ['172.18.0.2', '203.0.113.10'] } }))).toThrow(
      ForbiddenException,
    );
  });

  it('refuses a hop that is not an address, such as a proxy writing `unknown`', () => {
    expect(() => guard.canActivate(createContext({ ip: '172.18.0.2', headers: { 'x-forwarded-for': 'unknown, 172.18.0.2' } }))).toThrow(
      ForbiddenException,
    );
  });

  it('admits a wholly internal forwarded chain, including a tailnet hop', () => {
    expect(guard.canActivate(createContext({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '172.18.0.2, 100.101.102.103' } }))).toBe(true);
  });

  it('logs the path and the refusal reason, never the response body', () => {
    expect(() =>
      guard.canActivate(
        createContext({
          ip: '172.18.0.2',
          headers: { 'cf-ray': '8a1b2c3d4e5f-SJC' },
          method: 'GET',
          originalUrl: '/api/inference/apps/openclaw/credentials.env',
        }),
      ),
    ).toThrow(ForbiddenException);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toBe('[InternalOriginGuard] Refused GET /api/inference/apps/openclaw/credentials.env: tunnel-marker');
  });
});
