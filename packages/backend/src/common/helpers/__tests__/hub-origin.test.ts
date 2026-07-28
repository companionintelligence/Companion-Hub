import { describe, expect, it } from 'vitest';

import {
  buildHubLocalOrigin,
  buildHubPublicOrigin,
  buildHubTailnetOrigin,
  isLocalDevDomain,
  isPrivateHostname,
  isTailnetHostname,
} from '../hub-origin';

/**
 * The origin builders are load-bearing for the memory-connect flow: the public
 * origin must stay byte-identical to what ci-memory allowlists, and
 * `isPrivateHostname` decides whether a caller is offered the LAN launcher — a
 * false positive hands a remote browser an unroutable address.
 */
describe('buildHubPublicOrigin', () => {
  it('builds the tunnel origin from the hub subdomain and domain', () => {
    expect(buildHubPublicOrigin({ hubSubdomain: 'hub-core2-acme', domain: 'companionintelligence.com' })).toBe(
      'https://hub-core2-acme.companionintelligence.com',
    );
  });

  it('returns null for an unregistered appliance (no hub subdomain)', () => {
    expect(buildHubPublicOrigin({ hubSubdomain: undefined, domain: 'companionintelligence.com' })).toBeNull();
  });

  it('returns null for the unprovisioned placeholder domain rather than inventing a host', () => {
    expect(buildHubPublicOrigin({ hubSubdomain: 'hub-x', domain: 'example.com' })).toBeNull();
  });

  it('returns null when the domain is missing or blank', () => {
    expect(buildHubPublicOrigin({ hubSubdomain: 'hub-x', domain: '   ' })).toBeNull();
    expect(buildHubPublicOrigin({ hubSubdomain: 'hub-x', domain: null })).toBeNull();
  });
});

describe('buildHubLocalOrigin', () => {
  it('builds a LAN origin from the internal IP and gateway port', () => {
    expect(buildHubLocalOrigin({ internalIp: '192.168.1.9', port: 8080 })).toBe('http://192.168.1.9:8080');
  });

  it('omits port 80 so the origin matches what a browser reports', () => {
    // A trailing `:80` would make every URL.origin comparison this feeds fail.
    expect(buildHubLocalOrigin({ internalIp: '192.168.1.9', port: 80 })).toBe('http://192.168.1.9');
    expect(buildHubLocalOrigin({ internalIp: '192.168.1.9' })).toBe('http://192.168.1.9');
  });

  it('collapses a listen-all internal IP to loopback', () => {
    // 0.0.0.0 is not connectable from a browser, but the appliance DID report an
    // address — callers gate this on the caller's own host.
    expect(buildHubLocalOrigin({ internalIp: '0.0.0.0', port: 8080 })).toBe('http://127.0.0.1:8080');
    expect(buildHubLocalOrigin({ internalIp: '::', port: 8080 })).toBe('http://127.0.0.1:8080');
  });

  it('yields nothing at all when no internal IP is configured', () => {
    // NOT loopback: "we were never told the LAN address" is a different claim
    // from "the Hub is at 127.0.0.1". Publishing the latter would put a
    // meaningless origin into every app's CI_HUB_ORIGINS allowlist and offer it
    // as a launcher to browsers that are not on this machine.
    expect(buildHubLocalOrigin({ internalIp: undefined, port: 8080 })).toBeNull();
    expect(buildHubLocalOrigin({ internalIp: '   ', port: 8080 })).toBeNull();
  });

  it('brackets an IPv6 literal', () => {
    expect(buildHubLocalOrigin({ internalIp: 'fd00::1', port: 8080 })).toBe('http://[fd00::1]:8080');
  });
});

describe('isPrivateHostname', () => {
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.254', true],
    ['192.168.1.9', true],
    ['169.254.10.1', true],
    ['100.101.102.103', true],
    ['hub.local', true],
    ['core-2.lan', true],
    ['gateway.internal', true],
    // `.localhost` is loopback by RFC 6761 and the local/E2E gateway suffix, so a
    // caller there is on-machine and must be offered the LAN launcher.
    ['hub-core2-acme.ci.localhost', true],
    ['::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
  ])('treats %s as private', (host, expected) => {
    expect(isPrivateHostname(host)).toBe(expected);
  });

  it.each([
    ['hub-core2-acme.companionintelligence.com', false],
    ['8.8.8.8', false],
    // 172.32/12 is outside RFC1918 — an off-by-one here would leak the LAN
    // launcher to a public address.
    ['172.32.0.1', false],
    ['172.15.255.255', false],
    ['192.169.1.1', false],
    ['11.0.0.1', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('treats %s as public', (host, expected) => {
    expect(isPrivateHostname(host as string | null | undefined)).toBe(expected);
  });

  it('ignores case and IPv6 brackets', () => {
    expect(isPrivateHostname('HUB.LOCAL')).toBe(true);
    expect(isPrivateHostname('[::1]')).toBe(true);
  });
});

describe('buildHubTailnetOrigin', () => {
  it('builds an https origin from the node FQDN when the VPN is connected and servable', () => {
    expect(buildHubTailnetOrigin({ connected: true, httpsAvailable: true, nodeFqdn: 'hub-x.tail1234.ts.net' })).toBe('https://hub-x.tail1234.ts.net');
  });

  it('strips the trailing dot MagicDNS reports and lowercases', () => {
    // `tailscale status` returns DNSName with a trailing dot; an origin carrying
    // it would fail every URL.origin comparison it feeds.
    expect(buildHubTailnetOrigin({ connected: true, httpsAvailable: true, nodeFqdn: 'Hub-X.tail1234.ts.net.' })).toBe(
      'https://hub-x.tail1234.ts.net',
    );
  });

  it('returns null when disconnected — a stale FQDN is not an origin', () => {
    expect(buildHubTailnetOrigin({ connected: false, httpsAvailable: true, nodeFqdn: 'hub-x.tail1234.ts.net' })).toBeNull();
  });

  it('returns null without tailnet HTTPS — Serve cannot publish the origin', () => {
    expect(buildHubTailnetOrigin({ connected: true, httpsAvailable: false, nodeFqdn: 'hub-x.tail1234.ts.net' })).toBeNull();
  });

  it('returns null without a node FQDN', () => {
    expect(buildHubTailnetOrigin({ connected: true, httpsAvailable: true, nodeFqdn: '   ' })).toBeNull();
    expect(buildHubTailnetOrigin({ connected: true, httpsAvailable: true, nodeFqdn: null })).toBeNull();
  });
});

describe('isTailnetHostname', () => {
  it.each([
    ['hub-x.tail1234.ts.net', true],
    ['hub-x.tail1234.ts.net.', true],
    ['HUB-X.TAIL1234.TS.NET', true],
    // Tailscale assigns from the CGNAT range; a caller arriving from it is on
    // the VPN even though isPrivateHostname also claims it.
    ['100.64.0.1', true],
    ['100.90.154.85', true],
    ['100.127.255.254', true],
    // Tailscale's IPv6 assignment range (fd7a:115c:a1e0::/48), including the
    // bracketed form URL.hostname reports for IPv6 literals.
    ['fd7a:115c:a1e0::1', true],
    ['fd7a:115c:a1e0:ab12::2', true],
    ['[fd7a:115c:a1e0::1]', true],
  ])('treats %s as tailnet', (host, expected) => {
    expect(isTailnetHostname(host)).toBe(expected);
  });

  it.each([
    // CGNAT boundaries: 100.63/100.128 are ordinary public space.
    ['100.63.255.255', false],
    ['100.128.0.1', false],
    ['192.168.1.9', false],
    // Generic unique-local IPv6 is private but NOT the tailnet — it stays
    // `local` via isPrivateHostname.
    ['fd00::1', false],
    ['hub-core2-acme.companionintelligence.com', false],
    // Suffix must match as a label boundary tail, not a lookalike domain.
    ['evil-ts.net', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('treats %s as not tailnet', (host, expected) => {
    expect(isTailnetHostname(host as string | null | undefined)).toBe(expected);
  });
});

describe('isLocalDevDomain', () => {
  it('recognises the local/E2E domain', () => {
    expect(isLocalDevDomain('ci.localhost')).toBe(true);
  });

  it('does not match a real domain', () => {
    expect(isLocalDevDomain('companionintelligence.com')).toBe(false);
    expect(isLocalDevDomain(undefined)).toBe(false);
  });
});
