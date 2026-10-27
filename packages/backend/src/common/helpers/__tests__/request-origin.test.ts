import { describe, expect, it } from 'vitest';
import { internalOriginRefusal } from '../request-origin';

/**
 * The one definition of "this request came from inside the appliance", shared by
 * `InferenceAccessGuard` and its tests. Every case the pool's retired app-origin guard pinned is
 * here — tunnel markers, a public forwarded hop, a wholly private chain — plus the resolved-address
 * check that used to live in `InternalNetworkGuard` beside it, because the two are now one answer
 * and a caller that passes one but not the other must still be refused.
 */
describe('internalOriginRefusal', () => {
  it('admits a container-to-container call: a private address and no proxy headers at all', () => {
    expect(internalOriginRefusal({ ip: '172.18.0.5', headers: { host: 'ci-hub:3000', 'content-type': 'application/json' } })).toBeNull();
  });

  it('admits loopback, an IPv6-mapped private address, and a tailnet (CGNAT) address', () => {
    expect(internalOriginRefusal({ ip: '127.0.0.1', headers: {} })).toBeNull();
    expect(internalOriginRefusal({ ip: '::ffff:192.168.1.25', headers: {} })).toBeNull();
    expect(internalOriginRefusal({ ip: '100.101.102.103', headers: {} })).toBeNull();
  });

  // App subnets start at 10.128.0.0/24. Once the Hub joins an app network, inference arrives from
  // one of those addresses, and the credential-free leg has to admit it.
  it('admits a Hub-allocated app subnet address', () => {
    expect(internalOriginRefusal({ ip: '10.128.12.5', headers: { host: 'ci-hub:5002' } })).toBeNull();
  });

  it('falls back to the socket address when Express has not resolved `ip`', () => {
    expect(internalOriginRefusal({ socket: { remoteAddress: '::ffff:10.0.0.42' }, headers: {} })).toBeNull();
  });

  /** `req.ip` public means `HUB_TRUST_PROXY` resolved a real client, or the caller hit the port directly. */
  it('refuses a public resolved address, whatever the headers say', () => {
    expect(internalOriginRefusal({ ip: '203.0.113.10', headers: {} })).toBe('public-address');
    expect(internalOriginRefusal({ ip: '203.0.113.10', headers: { 'x-forwarded-for': '127.0.0.1' } })).toBe('public-address');
  });

  it('refuses a request with no address it can read', () => {
    expect(internalOriginRefusal({ headers: {} })).toBe('public-address');
    expect(internalOriginRefusal({ socket: {}, headers: {} })).toBe('public-address');
  });

  /**
   * Behind the tunnel `req.ip` is the proxy's own private address, so the address check passes; the
   * marker the edge adds is what says the caller is not inside. A caller cannot strip it.
   */
  it.each(['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'true-client-ip'])(
    'refuses tunnel traffic marked by %s even from a private proxy address',
    (header) => {
      expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { [header]: 'set' } })).toBe('tunnel-marker');
    },
  );

  it('refuses a forwarded chain whose client hop is public', () => {
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '203.0.113.10, 172.18.0.2' } })).toBe('forwarded-hop');
  });

  it('refuses a public hop in a repeated x-forwarded-for header', () => {
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': ['172.18.0.2', '203.0.113.10'] } })).toBe('forwarded-hop');
  });

  /**
   * A proxy that cannot name the client writes `unknown`; an address that cannot be read is not
   * inside. The `fd`-prefixed case is the one that used to slip through: `normalizeIpLiteral` hands
   * back the raw string, and `isPrivateOrLocalIp` once read a ULA prefix off it before checking it
   * was an address at all.
   */
  it.each(['unknown', '_hidden', 'fdxyz', 'fe80:garbage'])('refuses a hop that is not an address (%s)', (hop) => {
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': `${hop}, 172.18.0.2` } })).toBe('forwarded-hop');
  });

  it('refuses a resolved address that is not an address, whatever it starts with', () => {
    expect(internalOriginRefusal({ ip: 'fdxyz', headers: {} })).toBe('public-address');
  });

  it('admits a wholly internal forwarded chain, including a tailnet hop', () => {
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '172.18.0.2, 100.101.102.103' } })).toBeNull();
  });

  it('ignores empty hops, which a trailing comma or a doubled one produces', () => {
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '172.18.0.2,, 10.0.0.9,' } })).toBeNull();
  });

  /** The address is checked first so the reason names the outermost fact about the request. */
  it('reports the address before a marker when both refuse', () => {
    expect(internalOriginRefusal({ ip: '203.0.113.10', headers: { 'cf-ray': 'abc' } })).toBe('public-address');
  });
});

/**
 * The tailnet is inside the appliance by default (the tests above pin that), and `tailnetIsOutside` is how
 * one route asks for the opposite. It adds a fourth reason and takes nothing from the other three.
 */
describe('internalOriginRefusal with tailnetIsOutside', () => {
  const strict = { tailnetIsOutside: true };

  it('is off by default: a tailnet caller is inside, with or without the option spelled false', () => {
    expect(internalOriginRefusal({ ip: '100.101.102.103', headers: {} })).toBeNull();
    expect(internalOriginRefusal({ ip: '100.101.102.103', headers: {} }, {})).toBeNull();
    expect(internalOriginRefusal({ ip: '100.101.102.103', headers: {} }, { tailnetIsOutside: false })).toBeNull();
  });

  it('refuses a caller whose resolved address is a tailnet address, IPv4 or IPv6, mapped or not', () => {
    expect(internalOriginRefusal({ ip: '100.101.102.103', headers: {} }, strict)).toBe('tailnet-address');
    expect(internalOriginRefusal({ ip: '::ffff:100.101.102.103', headers: {} }, strict)).toBe('tailnet-address');
    expect(internalOriginRefusal({ ip: 'fd7a:115c:a1e0::1', headers: {} }, strict)).toBe('tailnet-address');
    expect(internalOriginRefusal({ socket: { remoteAddress: '100.64.0.9' }, headers: {} }, strict)).toBe('tailnet-address');
  });

  /** `tailscale serve` (and the sidecar) is a proxy: the Hub sees the proxy's own private address and the client in the chain. */
  it('refuses a tailnet client behind a private proxy, found in the forwarded chain', () => {
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '100.101.102.103' } }, strict)).toBe('tailnet-address');
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '172.18.0.2, 100.101.102.103' } }, strict)).toBe(
      'tailnet-address',
    );
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': ['172.18.0.2', 'fd7a:115c:a1e0::7'] } }, strict)).toBe(
      'tailnet-address',
    );
  });

  it('still admits everything inside the appliance that is not on the tailnet', () => {
    for (const ip of ['127.0.0.1', '::1', '172.18.0.5', '10.128.12.5', '192.168.1.25', '::ffff:10.0.0.42']) {
      expect(internalOriginRefusal({ ip, headers: { host: 'ci-hub:3000' } }, strict)).toBeNull();
    }
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '172.18.0.2, 10.128.1.9' } }, strict)).toBeNull();
  });

  it('keeps the other three reasons, and their priority over the new one', () => {
    expect(internalOriginRefusal({ ip: '203.0.113.10', headers: {} }, strict)).toBe('public-address');
    expect(internalOriginRefusal({ ip: '100.101.102.103', headers: { 'cf-ray': 'abc' } }, strict)).toBe('tunnel-marker');
    expect(internalOriginRefusal({ ip: '100.101.102.103', headers: { 'x-forwarded-for': '203.0.113.10, 100.101.102.103' } }, strict)).toBe(
      'forwarded-hop',
    );
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': 'unknown, 100.101.102.103' } }, strict)).toBe('forwarded-hop');
  });

  it('does not read a hop that is not an address as a tailnet address', () => {
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': '' } }, strict)).toBeNull();
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { 'x-forwarded-for': ',, ,' } }, strict)).toBeNull();
  });
});
