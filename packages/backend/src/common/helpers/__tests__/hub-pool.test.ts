import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeHubPoolDisabled,
  describeHubPoolInboundRefused,
  isHubPoolEnabled,
  normalizePeerFqdn,
  resolveHubPoolDirections,
  resolveHubPoolEnabled,
  type HubPoolDisabledBy,
} from '../hub-pool';

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

describe('resolveHubPoolDirections', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * The whole precedence, one row per reachable combination of the four inputs that bear on a
   * direction. Written out rather than derived, because this is the only place the rules live and a
   * loop that re-implements them would agree with a bug.
   *
   * Columns: the master env flag, the persisted master, the direction's own env flag, the
   * direction's persisted flag → the effective state of THAT direction.
   */
  type Row = [
    masterEnv: boolean,
    masterSetting: boolean | undefined,
    directionEnv: boolean,
    directionSetting: boolean | undefined,
    expected: { enabled: boolean; disabledBy: HubPoolDisabledBy | null },
  ];

  const ON = { enabled: true, disabledBy: null } as const;
  const OFF_ENV = { enabled: false, disabledBy: 'env' } as const;
  const OFF_SETTING = { enabled: false, disabledBy: 'setting' } as const;

  const TRUTH_TABLE: Row[] = [
    // Master env off wins over everything, including a direction that is explicitly on.
    [true, undefined, false, undefined, OFF_ENV],
    [true, undefined, false, false, OFF_ENV],
    [true, undefined, true, undefined, OFF_ENV],
    [true, undefined, true, false, OFF_ENV],
    [true, true, false, undefined, OFF_ENV],
    [true, false, false, undefined, OFF_ENV],
    // Master setting off: both directions off, attributed to the setting.
    [false, false, false, undefined, OFF_SETTING],
    [false, false, false, false, OFF_SETTING],
    // ...but the direction's own env flag does NOT get the credit — the master is what must change.
    [false, false, true, undefined, OFF_SETTING],
    [false, false, true, false, OFF_SETTING],
    // Master on: the direction's env flag wins over its persisted value.
    [false, undefined, true, undefined, OFF_ENV],
    [false, true, true, true, OFF_ENV],
    [false, true, true, false, OFF_ENV],
    // Master on, no direction env: the persisted direction flag decides, opt-out.
    [false, undefined, false, false, OFF_SETTING],
    [false, true, false, false, OFF_SETTING],
    // Everything on, including the untouched-settings.json case that must reproduce today exactly.
    [false, undefined, false, undefined, ON],
    [false, true, false, true, ON],
  ];

  it.each(
    TRUTH_TABLE,
  )('master env=%s setting=%s, direction env=%s setting=%s', (masterEnv, masterSetting, directionEnv, directionSetting, expected) => {
    if (masterEnv) vi.stubEnv('HUB_POOL_USER_DISABLED', 'true');
    if (directionEnv) vi.stubEnv('HUB_POOL_OUTBOUND_DISABLED', 'true');

    const directions = resolveHubPoolDirections({
      poolEnabled: masterSetting as boolean,
      poolOutboundEnabled: directionSetting as boolean,
      poolInboundEnabled: true,
    });

    expect(directions.outbound).toEqual(expected);
  });

  it('is on in both directions when nothing says otherwise — the untouched-appliance case', () => {
    // The regression fence for "a single-node Hub is completely unaffected": absent settings and an
    // absent .env must resolve to exactly what the build before these switches did.
    expect(resolveHubPoolDirections({ poolEnabled: undefined as unknown as boolean } as never)).toEqual({
      outbound: { enabled: true, disabledBy: null },
      inbound: { enabled: true, disabledBy: null },
    });
  });

  it('switches one direction without touching the other', () => {
    const outboundOff = resolveHubPoolDirections({ poolEnabled: true, poolOutboundEnabled: false, poolInboundEnabled: true });
    expect(outboundOff.outbound.enabled).toBe(false);
    expect(outboundOff.inbound.enabled).toBe(true);

    vi.stubEnv('HUB_POOL_INBOUND_DISABLED', 'true');
    const inboundOff = resolveHubPoolDirections({ poolEnabled: true, poolOutboundEnabled: true, poolInboundEnabled: true });
    expect(inboundOff.inbound).toEqual({ enabled: false, disabledBy: 'env' });
    expect(inboundOff.outbound.enabled).toBe(true);
  });

  it('only treats the exact string "true" as disabled, like the master switch', () => {
    vi.stubEnv('HUB_POOL_OUTBOUND_DISABLED', '1');
    expect(resolveHubPoolDirections({ poolEnabled: true, poolOutboundEnabled: true, poolInboundEnabled: true }).outbound.enabled).toBe(true);
  });

  it('describes an inbound refusal without blaming the master switch, which means something else', () => {
    // The master switch means "I have left the pool" and 503s the capability probe; these two mean
    // "still here, just not serving", so the copy must not send an operator to the same place.
    expect(describeHubPoolInboundRefused('inbound_disabled')).toContain('inbound pooling');
    expect(describeHubPoolInboundRefused('peer_disabled')).toContain('this peer');
    expect(describeHubPoolInboundRefused('inbound_disabled')).not.toContain('HUB_POOL_USER_DISABLED');
  });
});
