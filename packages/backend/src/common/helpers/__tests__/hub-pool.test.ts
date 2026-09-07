import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callerSourceIp,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  MAX_POOL_PRESSURE_WEIGHT,
  MAX_PRESSURE_BAND,
  MIN_POOL_PRESSURE_WEIGHT,
  UNKNOWN_PRESSURE,
  clampPressureBand,
  describeHubPoolDisabled,
  describeHubPoolInboundRefused,
  effectivePeerPressureBand,
  isCapabilitiesSnapshotFresh,
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

describe('callerSourceIp — the only address a per-source limiter may key on', () => {
  /** A request as Express hands it over: `ip` already resolved, headers as received. */
  function req(ip: string | undefined, headers: Record<string, string> = {}) {
    return { ip, headers };
  }

  it('returns the address when nothing sat in front of the request', () => {
    // The LAN / tailnet case, which is how pool peers actually arrive.
    expect(callerSourceIp(req('100.64.0.7'), undefined)).toBe('100.64.0.7');
  });

  it('refuses the address when the request came through the Cloudflare tunnel', () => {
    // `req.ip` here is the tunnel's own private address — the SAME value for every caller on earth,
    // so keying a "per-source" cooldown on it would silently make it a global one.
    expect(callerSourceIp(req('172.18.0.4', { 'cf-ray': 'abc123-LHR' }), undefined)).toBeUndefined();
    expect(callerSourceIp(req('172.18.0.4', { 'cf-connecting-ip': '203.0.113.9' }), undefined)).toBeUndefined();
  });

  it('refuses the address when any proxy forwarded the request', () => {
    expect(callerSourceIp(req('172.18.0.4', { 'x-forwarded-for': '203.0.113.9' }), undefined)).toBeUndefined();
  });

  it('trusts the address once HUB_TRUST_PROXY is set, because Express has then resolved the chain', () => {
    // The whole point of the variable: with it set, `req.ip` IS the client, and the IP key becomes
    // the meaningful defence-in-depth it was always meant to be.
    expect(callerSourceIp(req('203.0.113.9', { 'x-forwarded-for': '203.0.113.9, 172.18.0.4' }), '1')).toBe('203.0.113.9');
  });

  it('returns nothing when there is no address at all, rather than a bucket named "undefined"', () => {
    expect(callerSourceIp(req(undefined), undefined)).toBeUndefined();
  });

  it('tolerates a request object with no headers', () => {
    expect(callerSourceIp({ ip: '100.64.0.7' }, undefined)).toBe('100.64.0.7');
  });
});

describe('GPU-pressure helpers', () => {
  describe('clampPressureBand', () => {
    it.each([0, 1, 2, 3])('accepts the in-range band %i', (band) => {
      expect(clampPressureBand(band)).toBe(band);
    });

    it.each([
      ['a negative band', -1],
      ['a large negative band', -5],
      ['an out-of-range band', 4],
      ['a wildly out-of-range band', 99],
      ['a fraction', 1.5],
      ['a numeric string', '2'],
      ['a word', 'low'],
      ['null', null],
      ['undefined', undefined],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['an object', { band: 0 }],
      ['an array', [0]],
      ['true', true],
    ])('rejects %s', (_label, raw) => {
      // These arrive inside `last_capabilities`, which is jsonb a paired peer fully controls, and
      // rows can predate any write-side check — so the clamp has to live on the READ path.
      expect(clampPressureBand(raw)).toBeNull();
    });

    it('never maps a rejected value to 0, which would make it the most attractive candidate', () => {
      expect(clampPressureBand(-5)).not.toBe(0);
      expect(clampPressureBand('idle')).not.toBe(0);
    });
  });

  describe('UNKNOWN_PRESSURE', () => {
    it('is mid-band, not idle — an unmeasured node must never outrank one known to be idle', () => {
      expect(UNKNOWN_PRESSURE).toBe(1);
      expect(UNKNOWN_PRESSURE).toBeGreaterThan(0);
      expect(UNKNOWN_PRESSURE).toBeLessThan(MAX_PRESSURE_BAND);
    });
  });

  describe('isCapabilitiesSnapshotFresh', () => {
    const now = Date.parse('2026-09-07T12:00:00.000Z');

    it('accepts a snapshot inside the window', () => {
      expect(isCapabilitiesSnapshotFresh(new Date(now - 10_000).toISOString(), 90_000, now)).toBe(true);
    });

    it('rejects one past the window', () => {
      expect(isCapabilitiesSnapshotFresh(new Date(now - 91_000).toISOString(), 90_000, now)).toBe(false);
    });

    it('rejects a peer that has never been seen', () => {
      expect(isCapabilitiesSnapshotFresh(null, 90_000, now)).toBe(false);
    });

    it('rejects an unparseable timestamp rather than treating it as now', () => {
      expect(isCapabilitiesSnapshotFresh('not a date', 90_000, now)).toBe(false);
    });
  });

  describe('effectivePeerPressureBand', () => {
    it('returns a fresh, valid band unchanged', () => {
      expect(effectivePeerPressureBand({ reported: 2, snapshotFresh: true, forwardedInFlight: 0 })).toBe(2);
    });

    it('returns null when the peer reported nothing and we have forwarded nothing', () => {
      const band = effectivePeerPressureBand({ reported: undefined, snapshotFresh: true, forwardedInFlight: 0 });

      // Callers turn this into UNKNOWN_PRESSURE. Returning 0 here is the single defect that would
      // make silence the winning strategy for every node in the pool.
      expect(band).toBeNull();
      expect(band).not.toBe(0);
    });

    it('returns a measured 0, which is a claim and not an absence', () => {
      expect(effectivePeerPressureBand({ reported: 0, snapshotFresh: true, forwardedInFlight: 0 })).toBe(0);
    });

    it('discards the claim of a stale snapshot', () => {
      expect(effectivePeerPressureBand({ reported: 0, snapshotFresh: false, forwardedInFlight: 0 })).toBeNull();
    });

    it('floors the band by what we have forwarded, so a peer cannot pin itself at 0', () => {
      // Mirrors `peerLoad`'s max(): what we handed the peer is the one part of its load we observe
      // ourselves, and a peer running two of our requests is not idle whatever it claims.
      expect(effectivePeerPressureBand({ reported: 0, snapshotFresh: true, forwardedInFlight: 2 })).toBe(2);
    });

    it('keeps the floor even when the snapshot is stale, exactly as peerLoad does', () => {
      expect(effectivePeerPressureBand({ reported: 0, snapshotFresh: false, forwardedInFlight: 3 })).toBe(3);
    });

    it('takes the larger of claim and floor rather than their sum', () => {
      // Both numbers describe the same work from different vantage points; adding them would
      // double-count and drive an ordinary two-request peer straight to saturated.
      expect(effectivePeerPressureBand({ reported: 3, snapshotFresh: true, forwardedInFlight: 1 })).toBe(3);
    });

    it('caps the floor at the top band rather than running off the scale', () => {
      expect(effectivePeerPressureBand({ reported: 0, snapshotFresh: true, forwardedInFlight: 50 })).toBe(MAX_PRESSURE_BAND);
    });

    it.each([-5, 99, 1.5, 'low', null, Number.NaN])('ignores the hostile claim %s while honouring the floor', (hostile) => {
      expect(effectivePeerPressureBand({ reported: hostile, snapshotFresh: true, forwardedInFlight: 0 })).toBeNull();
      expect(effectivePeerPressureBand({ reported: hostile, snapshotFresh: true, forwardedInFlight: 2 })).toBe(2);
    });
  });

  describe('DEFAULT_POOL_PRESSURE_WEIGHT', () => {
    it('is 0, which is what removes the key from the comparator entirely', () => {
      // The default is not "small enough not to matter" — it is arithmetically absent, which is why
      // a fresh Hub ranks byte-identically to the build before this feature existed.
      expect(DEFAULT_POOL_PRESSURE_WEIGHT).toBe(0);
      expect(MIN_POOL_PRESSURE_WEIGHT).toBe(0);
      expect(MAX_POOL_PRESSURE_WEIGHT).toBe(MAX_PRESSURE_BAND);
    });
  });
});
