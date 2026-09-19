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
  it.each([
    'cf-ray',
    'cf-connecting-ip',
    'cf-visitor',
    'true-client-ip',
  ])('refuses tunnel traffic marked by %s even from a private proxy address', (header) => {
    expect(internalOriginRefusal({ ip: '172.18.0.2', headers: { [header]: 'set' } })).toBe('tunnel-marker');
  });

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
