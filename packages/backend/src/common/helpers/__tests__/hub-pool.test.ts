import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeHubPoolDisabled, isHubPoolEnabled, normalizePeerFqdn, resolveHubPoolEnabled } from '../hub-pool';

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

describe('resolveHubPoolEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is on when neither switch says otherwise, including before the setting has ever been written', () => {
    expect(resolveHubPoolEnabled(undefined)).toEqual({ enabled: true, disabledBy: null });
    expect(resolveHubPoolEnabled(true)).toEqual({ enabled: true, disabledBy: null });
  });

  it('reports the persisted setting as the reason when only it is off', () => {
    expect(resolveHubPoolEnabled(false)).toEqual({ enabled: false, disabledBy: 'setting' });
  });

  it('lets HUB_POOL_USER_DISABLED override a setting that says on', () => {
    // The whole point of the env switch: an operator-of-the-box decision a UI toggle cannot undo.
    vi.stubEnv('HUB_POOL_USER_DISABLED', 'true');

    expect(resolveHubPoolEnabled(true)).toEqual({ enabled: false, disabledBy: 'env' });
    expect(isHubPoolEnabled(true)).toBe(false);
  });

  it('attributes the env switch even when the setting is also off, so the UI names the one that must be changed', () => {
    vi.stubEnv('HUB_POOL_USER_DISABLED', 'true');

    expect(resolveHubPoolEnabled(false).disabledBy).toBe('env');
  });

  it('only treats the exact string "true" as disabled', () => {
    vi.stubEnv('HUB_POOL_USER_DISABLED', 'false');
    expect(resolveHubPoolEnabled(undefined).enabled).toBe(true);

    vi.stubEnv('HUB_POOL_USER_DISABLED', '1');
    expect(resolveHubPoolEnabled(undefined).enabled).toBe(true);
  });

  it('names the switch actually in force, so an operator does not go editing the wrong file', () => {
    expect(describeHubPoolDisabled('env')).toContain('HUB_POOL_USER_DISABLED');
    expect(describeHubPoolDisabled('setting')).toContain('Settings');
    expect(describeHubPoolDisabled('setting')).not.toContain('HUB_POOL_USER_DISABLED');
  });
});
