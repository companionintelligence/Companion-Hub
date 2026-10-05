import { candidate, incomingPeer, LOCAL_FQDN, poolPeer, poolStatus, poolWith, tailscaleStatus, waitingPeer } from '@/tests/pool-fixtures';
import { describe, expect, it } from 'vitest';
import type { PoolStatus } from '../../../helpers/hub-pool-shared';
import {
  PAIR_BY_ADDRESS_COMMAND,
  type PeerProgress,
  assessReadiness,
  canUnpair,
  chooseInitialStep,
  classifyPairFailure,
  countPoolModels,
  needsPolling,
  normalizeOs,
  normalizeTier,
  peerEngines,
  peerModelCount,
  peerProgress,
  poolInvitation,
  selectPairable,
  statusOf,
  unansweredTailnetDevices,
} from '../pool-setup-model';

const check = (readiness: ReturnType<typeof assessReadiness>, id: string) => readiness.checks.find((entry) => entry.id === id);

describe('assessReadiness', () => {
  it('reports level ok when pooling is on, Tailscale is connected with a name, HTTPS is available, and Serve is permitted', () => {
    const readiness = assessReadiness({ ts: tailscaleStatus(), pool: poolStatus() });

    expect(readiness.level).toBe('ok');
    expect(readiness.checks.map((entry) => [entry.id, entry.state])).toEqual([
      ['pooling', 'ok'],
      ['tailscale', 'ok'],
      ['https', 'ok'],
      ['serve', 'ok'],
      ['direction', 'ok'],
    ]);
    expect(check(readiness, 'tailscale')?.detailParams).toEqual({ name: LOCAL_FQDN });
  });

  it("treats disabledBy 'env' as blocked with no action and names the variable the user must remove", () => {
    const readiness = assessReadiness({ ts: tailscaleStatus(), pool: poolStatus({ enabled: false, disabledBy: 'env' }) });

    expect(readiness.level).toBe('blocked');
    expect(check(readiness, 'pooling')).toMatchObject({ state: 'blocked', detailKey: 'HUB_POOL_SETUP_POOLING_ENV' });
    expect(check(readiness, 'pooling')?.action).toBeUndefined();
  });

  it("treats disabledBy 'setting' as blocked with the turn-on-pooling action", () => {
    const readiness = assessReadiness({ ts: tailscaleStatus(), pool: poolStatus({ enabled: false, disabledBy: 'setting' }) });

    expect(check(readiness, 'pooling')).toMatchObject({ state: 'blocked', action: 'turn-on-pooling' });
  });

  it('treats a stored poolEnabled of false as off even before the status reports a reason', () => {
    const pool = poolStatus({ settings: { ...poolStatus().settings, poolEnabled: false } });

    expect(check(assessReadiness({ ts: tailscaleStatus(), pool }), 'pooling')).toMatchObject({ state: 'blocked', action: 'turn-on-pooling' });
  });

  it('blocks, with no action, when Tailscale is not installed', () => {
    const readiness = assessReadiness({ ts: tailscaleStatus({ installed: false, connected: false }), pool: poolStatus() });

    expect(check(readiness, 'tailscale')).toMatchObject({ state: 'blocked', detailKey: 'HUB_POOL_SETUP_TAILSCALE_MISSING' });
    expect(check(readiness, 'tailscale')?.action).toBeUndefined();
  });

  it('blocks with the connect-tailscale action when installed but not connected', () => {
    const readiness = assessReadiness({ ts: tailscaleStatus({ connected: false }), pool: poolStatus() });

    expect(check(readiness, 'tailscale')).toMatchObject({ state: 'blocked', action: 'connect-tailscale' });
    expect(readiness.level).toBe('blocked');
  });

  it('blocks when connected but the Hub has no tailnet name', () => {
    const readiness = assessReadiness({ ts: tailscaleStatus({ nodeFqdn: '' }), pool: poolStatus() });

    expect(check(readiness, 'tailscale')).toMatchObject({ state: 'blocked', detailKey: 'HUB_POOL_SETUP_TAILSCALE_NO_NAME' });
  });

  it('blocks with an unknown reading when the Tailscale status query failed, rather than passing it', () => {
    const readiness = assessReadiness({ ts: undefined, pool: poolStatus() });

    expect(check(readiness, 'tailscale')).toMatchObject({ state: 'blocked', detailKey: 'HUB_POOL_SETUP_TAILSCALE_UNKNOWN' });
  });

  it('leaves HTTPS and Serve out until Tailscale is connected, so one cause is not shown as three problems', () => {
    const readiness = assessReadiness({ ts: tailscaleStatus({ connected: false, httpsAvailable: false }), pool: poolStatus() });

    expect(readiness.checks.map((entry) => entry.id)).toEqual(['pooling', 'tailscale', 'direction']);
  });

  it('warns, never blocks, when httpsAvailable is false, and reads undefined as ok', () => {
    const off = assessReadiness({ ts: tailscaleStatus({ httpsAvailable: false }), pool: poolStatus() });
    const unknown = assessReadiness({ ts: tailscaleStatus({ httpsAvailable: undefined }), pool: poolStatus() });

    expect(check(off, 'https')).toMatchObject({ state: 'warn', action: 'open-tailscale-dns' });
    expect(off.level).toBe('warn');
    expect(check(unknown, 'https')?.state).toBe('ok');
    expect(unknown.level).toBe('ok');
  });

  it('warns and carries the remedy command when Tailscale refused Serve', () => {
    const readiness = assessReadiness({
      ts: tailscaleStatus({ servePermission: { denied: true, remedy: 'sudo tailscale set --operator=$USER' } }),
      pool: poolStatus(),
    });

    expect(check(readiness, 'serve')).toMatchObject({ state: 'warn', remedy: 'sudo tailscale set --operator=$USER' });
    expect(readiness.level).toBe('warn');
  });

  it('warns when the outbound direction is switched off', () => {
    const pool = poolStatus({ directions: { outbound: { enabled: false, disabledBy: null }, inbound: { enabled: true, disabledBy: null } } });
    const readiness = assessReadiness({ ts: tailscaleStatus(), pool });

    expect(check(readiness, 'direction')).toMatchObject({ state: 'warn', detailKey: 'HUB_POOL_SETUP_DIRECTION_OFF' });
    expect(readiness.level).toBe('warn');
  });

  it('lets blocked win over warn when both are present', () => {
    const readiness = assessReadiness({
      ts: tailscaleStatus({ connected: false }),
      pool: poolStatus({ directions: { outbound: { enabled: false, disabledBy: null }, inbound: { enabled: true, disabledBy: null } } }),
    });

    expect(readiness.level).toBe('blocked');
  });
});

describe('chooseInitialStep', () => {
  const ok = assessReadiness({ ts: tailscaleStatus(), pool: poolStatus() });
  const blocked = assessReadiness({ ts: tailscaleStatus({ connected: false }), pool: poolStatus() });
  const warn = assessReadiness({ ts: tailscaleStatus({ httpsAvailable: false }), pool: poolStatus() });

  it('resumes on approve whenever a peer row exists, even if readiness is blocked', () => {
    expect(chooseInitialStep({ peerCount: 1, readiness: ok })).toBe('approve');
    expect(chooseInitialStep({ peerCount: 3, readiness: blocked })).toBe('approve');
  });

  it('starts on find when there are no peers and readiness is ok', () => {
    expect(chooseInitialStep({ peerCount: 0, readiness: ok })).toBe('find');
  });

  it('starts on ready when there are no peers and readiness is warn or blocked', () => {
    expect(chooseInitialStep({ peerCount: 0, readiness: warn })).toBe('ready');
    expect(chooseInitialStep({ peerCount: 0, readiness: blocked })).toBe('ready');
  });
});

describe('selectPairable', () => {
  it('drops rows with verified false or source mdns and counts them as unverified, keeping order', () => {
    const list = [
      candidate('hub-b'),
      candidate('hub-x', { verified: false }),
      candidate('hub-c', { verified: true, source: 'portal' }),
      candidate('hub-y', { source: 'mdns', address: '192.0.2.7:443' }),
    ];

    const { pairable, unverifiedCount } = selectPairable(list);

    expect(pairable.map((device) => device.hostname)).toEqual(['hub-b', 'hub-c']);
    expect(unverifiedCount).toBe(2);
  });

  it('returns empty results for an empty scan', () => {
    expect(selectPairable([])).toEqual({ pairable: [], unverifiedCount: 0 });
  });
});

describe('classifyPairFailure', () => {
  it.each([
    [409, 'already'],
    [400, 'invalid'],
    [401, 'generic'],
    [403, 'generic'],
    [404, 'generic'],
    [500, 'unreachable'],
    [502, 'unreachable'],
    [0, 'unreachable'],
    [undefined, 'unreachable'],
  ] as const)('maps %s to %s', (status, expected) => {
    expect(classifyPairFailure(status)).toBe(expected);
  });
});

describe('statusOf', () => {
  it('reads error.http.status from a TranslatableError and falls back to response.status', () => {
    expect(statusOf({ http: { status: 409 } }, { status: 500 })).toBe(409);
    expect(statusOf(new Error('boom'), { status: 502 })).toBe(502);
    expect(statusOf({ message: 'x' }, new Response(null, { status: 400 }))).toBe(400);
  });

  it('is undefined when neither carries a status', () => {
    expect(statusOf(new Error('network'))).toBeUndefined();
    expect(statusOf(undefined, null)).toBeUndefined();
    expect(statusOf({ http: { status: 'oops' } }, {})).toBeUndefined();
  });
});

describe('peerProgress', () => {
  it('classifies incoming, waiting, verifying, verified, disabled, unreachable, needs_repair, needs_credentials, and half_paired rows', () => {
    expect(peerProgress(incomingPeer())).toBe('incoming');
    expect(peerProgress(waitingPeer())).toBe('waiting');
    expect(peerProgress(poolPeer({ lastSeenAt: null, lastCapabilities: null }))).toBe('verifying');
    expect(peerProgress(poolPeer({ lastCapabilities: null }))).toBe('verifying');
    expect(peerProgress(poolPeer())).toBe('verified');
    expect(peerProgress(poolPeer({ enabled: false }))).toBe('disabled');
    expect(peerProgress(poolPeer({ status: 'unreachable' }))).toBe('unreachable');
    expect(peerProgress(poolPeer({ status: 'unreachable', probeFailure: { kind: 'identity_changed', action: 'Unpair it.' } }))).toBe('needs_repair');
    expect(peerProgress(poolPeer({ status: 'unreachable', probeFailure: { kind: 'unauthorized', action: 'Re-pair.', httpStatus: 401 } }))).toBe(
      'needs_credentials',
    );
    expect(
      peerProgress(poolPeer({ status: 'unreachable', direction: 'inbound', probeFailure: { kind: 'unreachable', action: null, httpStatus: 403 } })),
    ).toBe('half_paired');
  });

  it('an unauthorized probe failure is needs_credentials, not a row that rejoins by itself, in either direction', () => {
    const unauthorized = { kind: 'unauthorized' as const, action: 'Re-pair.', httpStatus: 401 };

    expect(peerProgress(poolPeer({ status: 'unreachable', direction: 'inbound', probeFailure: unauthorized }))).toBe('needs_credentials');
    expect(peerProgress(poolPeer({ status: 'unreachable', direction: 'outbound', probeFailure: unauthorized }))).toBe('needs_credentials');
  });

  it('a row still marked connected is not judged on its first strike: one 401 can be a restart racing its own identity load', () => {
    const unauthorized = { kind: 'unauthorized' as const, action: 'Re-pair.', httpStatus: 401 };

    expect(peerProgress(poolPeer({ consecutiveFailures: 2, lastSeenAt: null, lastCapabilities: null, probeFailure: unauthorized }))).toBe(
      'verifying',
    );
    expect(peerProgress(poolPeer({ consecutiveFailures: 1, probeFailure: unauthorized }))).toBe('verified');
  });

  it('a never-read inbound row is half_paired after two 403s, not three, and not after one', () => {
    const forbidden = { kind: 'unreachable' as const, action: null, httpStatus: 403 };
    const unread = { direction: 'inbound' as const, lastSeenAt: null, lastCapabilities: null, probeFailure: forbidden };

    expect(peerProgress(poolPeer({ ...unread, consecutiveFailures: 1 }))).toBe('verifying');
    expect(peerProgress(poolPeer({ ...unread, consecutiveFailures: 2 }))).toBe('half_paired');
  });

  it('a row that was read before is not called half_paired early by a pair of 403s', () => {
    const forbidden = { kind: 'unreachable' as const, action: null, httpStatus: 403 };

    expect(peerProgress(poolPeer({ direction: 'inbound', consecutiveFailures: 2, probeFailure: forbidden }))).toBe('verified');
  });

  it('a disabled row stays disabled whatever its probes say', () => {
    const forbidden = { kind: 'unreachable' as const, action: null, httpStatus: 403 };

    expect(peerProgress(poolPeer({ enabled: false, status: 'unreachable', direction: 'inbound', probeFailure: forbidden }))).toBe('disabled');
  });

  it('only an inbound row that is unreachable with probeFailure httpStatus 403 is half_paired', () => {
    const failure = (httpStatus: number | null) => ({ kind: 'unreachable' as const, action: null, httpStatus });

    expect(peerProgress(poolPeer({ status: 'unreachable', direction: 'outbound', probeFailure: failure(403) }))).toBe('unreachable');
    expect(peerProgress(poolPeer({ status: 'unreachable', direction: 'inbound', probeFailure: failure(500) }))).toBe('unreachable');
    expect(peerProgress(poolPeer({ status: 'unreachable', direction: 'inbound', probeFailure: failure(null) }))).toBe('unreachable');
    expect(peerProgress(poolPeer({ status: 'unreachable', direction: 'inbound' }))).toBe('unreachable');
  });
});

describe('canUnpair', () => {
  it('offers Unpair on exactly the states that waiting never clears', () => {
    const all: PeerProgress[] = [
      'incoming',
      'waiting',
      'verifying',
      'verified',
      'disabled',
      'unreachable',
      'needs_repair',
      'needs_credentials',
      'half_paired',
    ];

    expect(all.filter(canUnpair)).toEqual(['needs_repair', 'needs_credentials', 'half_paired']);
  });
});

describe('needsPolling', () => {
  it('is true for pending or unverified connected peers', () => {
    expect(needsPolling(poolWith([waitingPeer()]))).toBe(true);
    expect(needsPolling(poolWith([incomingPeer()]))).toBe(true);
    expect(needsPolling(poolWith([poolPeer({ lastCapabilities: null })]))).toBe(true);
  });

  it('is false for settled, empty, unreachable-only, and unknown pools', () => {
    expect(needsPolling(poolWith([poolPeer()]))).toBe(false);
    expect(needsPolling(poolStatus())).toBe(false);
    expect(needsPolling(poolWith([poolPeer({ status: 'unreachable' })]))).toBe(false);
    expect(
      needsPolling(poolWith([poolPeer({ status: 'unreachable', probeFailure: { kind: 'unauthorized', action: 'Re-pair.', httpStatus: 401 } })])),
    ).toBe(false);
    expect(needsPolling(poolWith([poolPeer({ enabled: false, lastCapabilities: null })]))).toBe(false);
    // Half paired is a verdict waiting cannot change, so polling for it to clear would run for ten minutes for nothing.
    expect(
      needsPolling(
        poolWith([
          poolPeer({
            direction: 'inbound',
            lastSeenAt: null,
            lastCapabilities: null,
            consecutiveFailures: 2,
            probeFailure: { kind: 'unreachable', action: null, httpStatus: 403 },
          }),
        ]),
      ),
    ).toBe(false);
    expect(needsPolling(undefined)).toBe(false);
  });
});

describe('model counts', () => {
  it('peerModelCount counts distinct models on healthy backends only', () => {
    const peer = poolPeer({
      lastCapabilities: {
        hardwareTier: 'server',
        updatedAt: '2026-10-01T10:00:00.000Z',
        backends: [
          { type: 'ollama', healthy: true, modelsLoaded: ['a', 'b'] },
          { type: 'vllm', healthy: true, modelsLoaded: ['b', 'c'] },
          { type: 'lemonade', healthy: false, modelsLoaded: ['d'] },
        ],
      },
    });

    expect(peerModelCount(peer)).toBe(3);
    expect(peerModelCount(poolPeer({ lastCapabilities: null }))).toBe(0);
  });

  it("countPoolModels counts local plus connected healthy backends and excludes an unreachable peer's cached models", () => {
    const pool = poolWith([
      poolPeer({ id: 'p1' }),
      poolPeer({
        id: 'p2',
        nodeFqdn: 'hub-d.example-tailnet.ts.net',
        status: 'unreachable',
        lastCapabilities: { hardwareTier: 'server', updatedAt: 'x', backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['only-on-d'] }] },
      }),
    ]);

    // llama3.2:3b is local and on p1; qwen3:8b only on p1; 'only-on-d' is cached on an unreachable peer.
    expect(countPoolModels(pool)).toBe(2);
  });
});

describe('unansweredTailnetDevices', () => {
  const ts = tailscaleStatus({
    peers: [
      { nodeFqdn: 'hub-b.example-tailnet.ts.net', hostname: 'hub-b', ip: '100.64.0.2', online: true },
      { nodeFqdn: 'nas.example-tailnet.ts.net', hostname: 'nas', ip: '100.64.0.3', online: true },
      { nodeFqdn: 'phone.example-tailnet.ts.net', hostname: 'phone', ip: '100.64.0.4', online: false },
      { nodeFqdn: 'tv.example-tailnet.ts.net', hostname: 'tv', ip: '100.64.0.5' },
    ],
  });

  it('lists tailnet devices not already in the pool, marks offline ones, and treats a missing flag as online', () => {
    const result = unansweredTailnetDevices({ ts, pool: poolWith([poolPeer()]) });

    expect(result.total).toBe(3);
    expect(result.shown).toEqual([
      { name: 'nas', nodeFqdn: 'nas.example-tailnet.ts.net', online: true },
      { name: 'phone', nodeFqdn: 'phone.example-tailnet.ts.net', online: false },
      { name: 'tv', nodeFqdn: 'tv.example-tailnet.ts.net', online: true },
    ]);
    expect(result.more).toBe(0);
  });

  it('keeps two devices that report the same hostname apart by their tailnet names', () => {
    const twins = tailscaleStatus({
      peers: [
        { nodeFqdn: 'iphone.example-tailnet.ts.net', hostname: 'iPhone', ip: '100.64.2.1' },
        { nodeFqdn: 'iphone-1.example-tailnet.ts.net', hostname: 'iPhone', ip: '100.64.2.2' },
      ],
    });

    const { shown } = unansweredTailnetDevices({ ts: twins, pool: poolStatus() });

    expect(shown.map((device) => device.name)).toEqual(['iPhone', 'iPhone']);
    expect(new Set(shown.map((device) => device.nodeFqdn)).size).toBe(2);
  });

  it('caps the list and reports how many were left out', () => {
    const many = tailscaleStatus({
      peers: Array.from({ length: 11 }, (_, index) => ({
        nodeFqdn: `n${index}.example-tailnet.ts.net`,
        hostname: `n${index}`,
        ip: `100.64.1.${index}`,
      })),
    });

    const result = unansweredTailnetDevices({ ts: many, pool: poolStatus() });

    expect(result.total).toBe(11);
    expect(result.shown).toHaveLength(8);
    expect(result.more).toBe(3);
  });

  it('never lists this Hub itself and compares names case-insensitively, ignoring a trailing dot', () => {
    const self = tailscaleStatus({ peers: [{ nodeFqdn: `${LOCAL_FQDN}.`.toUpperCase(), hostname: 'hub-a', ip: '100.64.0.1' }] });

    expect(unansweredTailnetDevices({ ts: self, pool: poolStatus() }).total).toBe(0);
  });
});

describe('poolInvitation', () => {
  const base = { registered: true, demoMode: false, dismissed: false };

  it('shows invite only when registered, enabled, Tailscale connected, peerCounts.total is 0, and not dismissed', () => {
    expect(poolInvitation({ ...base, status: poolStatus() })).toEqual({ kind: 'invite' });

    const failing: Array<[string, Parameters<typeof poolInvitation>[0]]> = [
      ['unregistered', { ...base, registered: false, status: poolStatus() }],
      ['dismissed', { ...base, dismissed: true, status: poolStatus() }],
      ['demo mode', { ...base, demoMode: true, status: poolStatus() }],
      ['pooling off', { ...base, status: poolStatus({ enabled: false, disabledBy: 'setting' }) }],
      ['Tailscale down', { ...base, status: poolStatus({ localNode: { ...poolStatus().localNode, tailscaleConnected: false } }) }],
      ['status unknown', { ...base, status: undefined }],
    ];
    for (const [, input] of failing) {
      expect(poolInvitation(input)).toEqual({ kind: 'none' });
    }
  });

  it('hides invite when any peer exists, including a single pending outbound row', () => {
    expect(poolInvitation({ ...base, status: poolWith([waitingPeer()]) })).toEqual({ kind: 'none' });
    expect(poolInvitation({ ...base, status: poolWith([poolPeer()]) })).toEqual({ kind: 'none' });
  });

  it('returns review for an inbound pending peer regardless of dismissal, registration, or other peers, and lists up to the requesters it was given', () => {
    const status = poolWith([poolPeer(), incomingPeer(), incomingPeer({ id: 'peer-in-2', nodeFqdn: 'hub-e.example-tailnet.ts.net' })]);

    const result = poolInvitation({ registered: false, demoMode: false, dismissed: true, status });

    expect(result).toEqual({
      kind: 'review',
      requests: [
        { id: 'peer-in', label: 'hub-c.example-tailnet.ts.net' },
        { id: 'peer-in-2', label: 'hub-e.example-tailnet.ts.net' },
      ],
    });
  });

  it("labels a request by its tailnet name, never by the requester's self-chosen display name", () => {
    const result = poolInvitation({ ...base, status: poolWith([incomingPeer({ displayName: 'Definitely your own laptop' })]) });

    expect(result).toMatchObject({ kind: 'review', requests: [{ label: 'hub-c.example-tailnet.ts.net' }] });
  });

  it('returns none in demo mode, when pooling is off, and while status is undefined, even with a request waiting', () => {
    const waiting = poolWith([incomingPeer()]);

    expect(poolInvitation({ ...base, demoMode: true, status: waiting })).toEqual({ kind: 'none' });
    expect(poolInvitation({ ...base, status: { ...waiting, enabled: false, disabledBy: 'env' } as PoolStatus })).toEqual({ kind: 'none' });
    expect(poolInvitation({ ...base, status: undefined })).toEqual({ kind: 'none' });
  });
});

describe('normalizeOs', () => {
  it.each([
    ['linux', 'linux'],
    ['Linux', 'linux'],
    ['LINUX', 'linux'],
    ['macOS', 'macos'],
    ['macos', 'macos'],
    ['darwin', 'macos'],
    ['Darwin', 'macos'],
    ['windows', 'windows'],
    ['Windows', 'windows'],
  ])('reads %j as %s, whatever its case', (os, expected) => {
    expect(normalizeOs(os)).toBe(expected);
  });

  it('ignores the whitespace around a name', () => {
    expect(normalizeOs('  Linux ')).toBe('linux');
    expect(normalizeOs('\tmacOS\n')).toBe('macos');
  });

  it.each([['iOS'], ['android'], ['freebsd'], ['tvOS'], ['ubuntu'], ['windows 11'], ['linux-gnu'], ['']])(
    'leaves %j as other, rather than guessing the family from a name it was not told',
    (os) => {
      expect(normalizeOs(os)).toBe('other');
    },
  );

  it.each([[null], [undefined]])('reads %j as other', (os) => {
    expect(normalizeOs(os)).toBe('other');
  });
});

describe('normalizeTier', () => {
  it.each([['high'], ['medium'], ['cpu-only']] as const)('passes the pool’s own tier %s through unchanged', (tier) => {
    expect(normalizeTier(tier)).toBe(tier);
  });

  it.each([['server'], ['workstation'], ['High'], ['cpu_only'], ['cpu'], ['quantum'], ['']])(
    'drops %j, which is not one of the tiers the guide has a label for',
    (tier) => {
      expect(normalizeTier(tier)).toBeNull();
    },
  );

  it.each([[null], [undefined]])('is null for %j', (tier) => {
    expect(normalizeTier(tier)).toBeNull();
  });
});

describe('peerEngines', () => {
  const withBackends = (backends: { type: string; healthy: boolean; modelsLoaded?: string[] }[]) =>
    poolPeer({
      lastCapabilities: {
        hardwareTier: 'high',
        updatedAt: '2026-10-01T10:00:00.000Z',
        backends: backends.map((backend) => ({ modelsLoaded: [], ...backend })),
      },
    });

  it('is empty for a peer that has not reported capabilities yet', () => {
    expect(peerEngines(waitingPeer())).toEqual([]);
    expect(peerEngines(poolPeer({ lastCapabilities: null }))).toEqual([]);
  });

  it('is empty for a peer that reported no engines, which is not the same as one whose engines are all down', () => {
    expect(peerEngines(withBackends([]))).toEqual([]);
  });

  it('lists the healthy engines first, then the unhealthy ones, each group in name order', () => {
    const peer = withBackends([
      { type: 'vllm', healthy: false },
      { type: 'ollama', healthy: true },
      { type: 'lemonade', healthy: true },
      { type: 'a-engine', healthy: false },
    ]);

    expect(peerEngines(peer)).toEqual([
      { type: 'lemonade', healthy: true },
      { type: 'ollama', healthy: true },
      { type: 'a-engine', healthy: false },
      { type: 'vllm', healthy: false },
    ]);
  });

  it('gives the same order whatever order the peer reported its engines in', () => {
    const backends = [
      { type: 'vllm', healthy: true },
      { type: 'ollama', healthy: false },
      { type: 'lemonade', healthy: true },
    ];

    expect(peerEngines(withBackends(backends))).toEqual(peerEngines(withBackends([...backends].reverse())));
  });

  it('carries only the engine and whether it is running, never the models it holds', () => {
    const [engine] = peerEngines(withBackends([{ type: 'ollama', healthy: true, modelsLoaded: ['llama3.2:3b'] }]));

    expect(engine).toEqual({ type: 'ollama', healthy: true });
    expect(engine).not.toHaveProperty('modelsLoaded');
  });

  it('does not reorder the peer’s own record while sorting', () => {
    const peer = withBackends([
      { type: 'vllm', healthy: false },
      { type: 'ollama', healthy: true },
    ]);

    peerEngines(peer);

    expect(peer.lastCapabilities?.backends.map((backend) => backend.type)).toEqual(['vllm', 'ollama']);
  });
});

describe('constants', () => {
  it('keeps the address-and-PIN command as a literal for the user to fill in', () => {
    expect(PAIR_BY_ADDRESS_COMMAND).toBe('cihub pool pair <address> --pin <digits>');
  });
});
