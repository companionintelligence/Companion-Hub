import { describe, expect, it } from 'vitest';
import { normalizePeerFqdn } from '../hub-pool';

describe('normalizePeerFqdn', () => {
  it('accepts and canonicalizes a MagicDNS name', () => {
    expect(normalizePeerFqdn('hub-demo.tailxyz.ts.net')).toBe('hub-demo.tailxyz.ts.net');
    expect(normalizePeerFqdn('  Hub-Demo.TailXYZ.TS.NET  ')).toBe('hub-demo.tailxyz.ts.net');
    expect(normalizePeerFqdn('hub-demo.tailxyz.ts.net.')).toBe('hub-demo.tailxyz.ts.net');
  });

  it.each([
    ['a scheme', 'https://evil.example.com'],
    ['a scheme-relative host', '//evil.example.com'],
    ['embedded credentials', 'peer.ts.net@evil.example.com'],
    ['a port', 'peer.ts.net:8443'],
    ['a path', 'peer.ts.net/../../attacker'],
    ['a query', 'peer.ts.net?x=1'],
    ['a fragment', 'peer.ts.net#frag'],
    ['percent-encoding', 'peer%2ets%2enet'],
    ['whitespace inside', 'peer .ts.net'],
    ['an empty label', 'peer..ts.net'],
    ['a leading dot', '.peer.ts.net'],
    ['a leading hyphen', '-peer.ts.net'],
    ['a single label', 'localhost'],
    ['an IPv4 literal', '10.0.0.1'],
    ['a bracketed IPv6 literal', '[::1]'],
    ['an IPv6 literal', 'fd7a:115c:a1e0::1'],
    ['an empty string', '   '],
  ])('rejects %s', (_case, value) => {
    expect(normalizePeerFqdn(value)).toBeNull();
  });

  it('rejects a name longer than the DNS maximum', () => {
    const label = 'a'.repeat(63);
    expect(normalizePeerFqdn(`${label}.${label}.${label}.${label}.net`)).toBeNull();
  });
});
