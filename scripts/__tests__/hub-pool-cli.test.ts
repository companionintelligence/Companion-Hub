import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DiscoverablePoolPeer,
  type PoolPeerRow,
  type PoolProbeResult,
  type PoolRoutingLogResponse,
  type PoolStatusResponse,
  formatPoolDiscoverLines,
  formatPoolPeerTable,
  formatPoolPeersLines,
  formatPoolProbeLines,
  formatPoolRoutingLogLines,
  formatPoolStatusLines,
  formatPoolTimestamp,
  probePoolAddress,
  resolvePoolPeerTarget,
  runPoolDiscover,
  setPoolEnabledSetting,
  unpairPoolPeer,
} from '../hub-pool-cli';

const hubApiFetch = vi.fn();

vi.mock('../public-web-cli', () => ({
  hubApiFetch: (...args: unknown[]) => hubApiFetch(...args),
}));

// Placeholder tailnet names only — docs/README.md tip-scrub policy.
const PEER_A = 'hub-b.example-tailnet.ts.net';
const PEER_B = 'hub-c.example-tailnet.ts.net';

function peer(overrides: Partial<PoolPeerRow> = {}): PoolPeerRow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    nodeFqdn: PEER_A,
    displayName: null,
    direction: 'outbound',
    status: 'connected',
    enabled: true,
    consecutiveFailures: 0,
    lastSeenAt: '2026-09-05T10:00:01.000Z',
    lastCapabilities: { hardwareTier: 'high', backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['llama3', 'qwen3'] }] },
    inFlightRequests: 2,
    ...overrides,
  };
}

function status(overrides: Partial<PoolStatusResponse> = {}): PoolStatusResponse {
  return {
    enabled: true,
    disabledBy: null,
    directions: { outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } },
    reason: 'active',
    routingActive: true,
    settings: { poolEnabled: true, poolOutboundEnabled: true, poolInboundEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
    tailscaleAdminApiConfigured: true,
    localNode: {
      nodeFqdn: 'hub-a.example-tailnet.ts.net',
      tailnet: 'example-tailnet.ts.net',
      tailscaleConnected: true,
      inFlightRequests: 0,
      hardwareTier: 'high',
      backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['llama3'] }],
      capabilitiesError: null,
    },
    peers: [peer()],
    peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 },
    routing: { recorded: 3, capacity: 200, served: 2, failed: 1, failovers: 1, lastAt: '2026-09-05T10:00:01.000Z' },
    ...overrides,
  };
}

describe('hub-pool-cli formatters', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  it('renders an active pool with the local node, counts, settings and peer table', () => {
    const lines = formatPoolStatusLines(status());
    const text = lines.join('\n');

    expect(text).toContain('Pooling      ✓ active');
    expect(text).toContain('1 total · 1 connected · 0 pending · 0 unreachable · 0 disabled');
    expect(text).toContain('poolEnabled=true · outbound=true · inbound=true · localAffinity=1 · healthPoll=30s');
    expect(text).toContain('hub-a.example-tailnet.ts.net');
    expect(text).toContain('tailnet example-tailnet.ts.net');
    expect(text).toContain('ollama ✓ 1');
    // Peer row: status, last seen, queue depth and engines all present.
    expect(text).toContain('hub-b.example-tailnet.ts.net');
    expect(text).toContain('2026-09-05 10:00:01Z');
    expect(text).toContain('ollama ✓ 2');
  });

  it('renders each direction and names the switch actually holding it off', () => {
    const text = formatPoolStatusLines(
      status({
        reason: 'partially_disabled',
        routingActive: false,
        directions: { outbound: { enabled: false, disabledBy: 'setting' }, inbound: { enabled: false, disabledBy: 'env' } },
        settings: { poolEnabled: true, poolOutboundEnabled: false, poolInboundEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
      }),
    ).join('\n');

    expect(text).toContain('partly disabled');
    // Each line points at the thing that actually has to change, per direction.
    expect(text).toContain('cihub pool enable --outbound');
    expect(text).toContain('HUB_POOL_INBOUND_DISABLED=true');
    expect(text).toContain('poolEnabled=true · outbound=false · inbound=true');
  });

  it('marks a disabled peer instead of printing "connected" for a node that exchanges no work', () => {
    const text = formatPoolStatusLines(
      status({ peers: [peer({ enabled: false })], peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 1 } }),
    ).join('\n');

    expect(text).toContain('connected/off');
    expect(text).toContain('1 disabled');
  });

  it('names the env override rather than reporting a plain "off"', () => {
    const text = formatPoolStatusLines(status({ enabled: false, disabledBy: 'env', reason: 'disabled_by_env', routingActive: false })).join('\n');
    expect(text).toContain('HUB_POOL_USER_DISABLED=true');
    expect(text).toContain('the .env wins over the setting');
  });

  it('separates "enabled but no peers" from "disabled"', () => {
    const text = formatPoolStatusLines(
      status({
        reason: 'no_peers',
        routingActive: false,
        peers: [],
        peerCounts: { total: 0, connected: 0, pending: 0, unreachable: 0, disabled: 0 },
      }),
    ).join('\n');
    expect(text).toContain('enabled, not routing');
    expect(text).toContain('No paired peers');
  });

  it('says why the local inventory is empty when a backend is down', () => {
    const text = formatPoolStatusLines(status({ localNode: { ...status().localNode, backends: [], capabilitiesError: 'ollama unreachable' } })).join(
      '\n',
    );
    expect(text).toContain('✗ ollama unreachable');
  });

  it('shows the strike count next to a failing peer status', () => {
    const text = formatPoolPeerTable([peer({ status: 'unreachable', consecutiveFailures: 2 })]).join('\n');
    expect(text).toContain('unreachable 2/3');
  });

  it('surfaces the approve/reject hint only when an inbound request is pending', () => {
    const pending = formatPoolPeersLines([peer({ direction: 'inbound', status: 'pending', lastCapabilities: null })]).join('\n');
    expect(pending).toContain('cihub pool approve <id>');
    expect(formatPoolPeersLines([peer()]).join('\n')).not.toContain('cihub pool approve <id>');
  });

  it('lists each peer’s models under the table', () => {
    const text = formatPoolPeersLines([peer()]).join('\n');
    expect(text).toContain('ollama: llama3, qwen3');
  });

  it('strips control characters from server-supplied values', () => {
    const esc = String.fromCharCode(27);
    const text = formatPoolPeerTable([peer({ nodeFqdn: `hub-${esc}[2Jx.example-tailnet.ts.net` })]).join('\n');
    expect(text).not.toContain(esc);
  });

  it('formats timestamps and tolerates a non-ISO value', () => {
    expect(formatPoolTimestamp('2026-09-05T10:00:01.000Z')).toBe('2026-09-05 10:00:01Z');
    expect(formatPoolTimestamp(null)).toBe('-');
    expect(formatPoolTimestamp('not a date')).toBe('not a date');
  });

  it('renders the failover chain, not just a count', () => {
    const log: PoolRoutingLogResponse = {
      entries: [
        {
          at: '2026-09-05T10:00:01.000Z',
          direction: 'outbound',
          path: '/v1/chat/completions',
          model: 'llama3',
          node: PEER_A,
          peerId: 'p1',
          backend: 'ollama',
          candidates: 3,
          attempt: 2,
          failedOverFrom: ['local'],
          outcome: 'served',
          status: 200,
          durationMs: 1204,
        },
      ],
      summary: { recorded: 1, capacity: 200, served: 1, failed: 0, failovers: 1, lastAt: '2026-09-05T10:00:01.000Z' },
    };
    const text = formatPoolRoutingLogLines(log).join('\n');
    expect(text).toContain('↳ failed over from local');
    expect(text).toContain('2/3');
    expect(text).toContain('✓ served 200');
    // Column widths must not eat the timestamp or the peer name — both identify the decision.
    expect(text).toContain('2026-09-05 10:00:01Z');
    expect(text).toContain(PEER_A);
  });

  it('explains an empty routing log rather than showing an empty table', () => {
    const text = formatPoolRoutingLogLines({
      entries: [],
      summary: { recorded: 0, capacity: 200, served: 0, failed: 0, failovers: 0, lastAt: null },
    }).join('\n');
    expect(text).toContain('Nothing routed since the Hub started.');
    expect(text).toContain('in-memory and process-local');
  });

  it('resolves a peer by id prefix or FQDN and refuses an ambiguous prefix', () => {
    const peers = [peer(), peer({ id: '11111111-9999-0000-0000-000000000000', nodeFqdn: PEER_B })];
    expect(resolvePoolPeerTarget(peers, PEER_B)).toEqual({ peer: peers[1] });
    expect(resolvePoolPeerTarget(peers, '11111111-2222-3333-4444-555555555555')).toEqual({ peer: peers[0] });
    expect(resolvePoolPeerTarget(peers, '11111111')).toEqual({ error: expect.stringContaining('matches 2 peers') });
    expect(resolvePoolPeerTarget(peers, 'nope')).toEqual({ error: expect.stringContaining('No paired peer matching') });
  });
});

describe('hub-pool-cli discovery', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  it('still asks for the candidate list with no Admin API credential, because manual entries come back on it', async () => {
    // Deliberately changed: this used to short-circuit on `tailscaleAdminApiConfigured: false`,
    // back when that credential was the only source of candidates. A node added with
    // `cihub pool probe` is returned by the same route, so short-circuiting made manual entries
    // invisible on exactly the Hubs that have no credential — the ones the feature is for.
    hubApiFetch.mockResolvedValueOnce(status({ tailscaleAdminApiConfigured: false })).mockResolvedValueOnce([]);

    const result = await runPoolDiscover('.env.local');

    expect(result.configured).toBe(false);
    expect(hubApiFetch.mock.calls[1]?.[1]).toBe('/inference/pool/peers/discoverable');
  });

  it('offers manual entry first and the OAuth credential second when nothing is found', async () => {
    hubApiFetch.mockResolvedValueOnce(status({ tailscaleAdminApiConfigured: false })).mockResolvedValueOnce([]);

    const text = (await runPoolDiscover('.env.local')).lines.join('\n');

    expect(text).toContain('cihub pool probe <address>');
    expect(text).toContain('TAILSCALE_OAUTH_CLIENT_ID');
    // The credential stays genuinely optional, and the copy has to keep saying so.
    expect(text).toContain('pools normally without it');
  });

  it('distinguishes a configured-but-empty tailnet from the unconfigured case', async () => {
    hubApiFetch.mockResolvedValueOnce(status()).mockResolvedValueOnce([]);

    const result = await runPoolDiscover('.env.local');

    expect(result.configured).toBe(true);
    expect(hubApiFetch.mock.calls[1]?.[1]).toBe('/inference/pool/peers/discoverable');
    expect(result.lines.join('\n')).toContain('Tailnet enumeration is configured, and found nothing unpaired.');
  });

  it('lists discoverable devices with the pair hint', () => {
    const devices: DiscoverablePoolPeer[] = [{ tailscaleDeviceId: 'dev-1', nodeFqdn: PEER_A, hostname: 'hub-b' }];
    const text = formatPoolDiscoverLines(devices, true).join('\n');
    expect(text).toContain(PEER_A);
    expect(text).toContain('cihub pool pair <node>');
  });

  it('says how each candidate was found, rather than printing a blank device id', () => {
    const devices: DiscoverablePoolPeer[] = [
      { tailscaleDeviceId: 'dev-1', nodeFqdn: PEER_A, hostname: 'hub-b', source: 'tailscale' },
      { tailscaleDeviceId: '', nodeFqdn: 'lan-box.example-tailnet.ts.net', hostname: 'lan-box', source: 'lan-probe' },
    ];

    const text = formatPoolDiscoverLines(devices, true).join('\n');

    expect(text).toContain('FOUND VIA');
    expect(text).toContain('tailnet');
    expect(text).toContain('address');
    expect(text).toContain('-');
  });

  it('renders an off-box hostname through sanitizeForBox', () => {
    // Box output is ANSI-injectable, and every string on a candidate row is authored off-box now
    // that one of the sources is "whatever answered at an address the operator typed".
    const devices: DiscoverablePoolPeer[] = [{ tailscaleDeviceId: '', nodeFqdn: PEER_A, hostname: '[31mred[0m', source: 'lan-probe' }];

    expect(formatPoolDiscoverLines(devices, false).join('\n')).not.toContain('[31m');
  });
});

describe('hub-pool-cli probe', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  function probeResult(overrides: Partial<PoolProbeResult> = {}): PoolProbeResult {
    return {
      address: '192.168.1.42',
      isCiHub: true,
      nodeFqdn: PEER_A,
      hostname: 'hub-b',
      alreadyPaired: false,
      pairable: true,
      reason: null,
      ...overrides,
    };
  }

  it('posts the address the operator typed, unmodified', async () => {
    hubApiFetch.mockResolvedValueOnce(probeResult());

    await probePoolAddress('.env.local', '192.168.1.42:5010');

    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/pool/peers/probe');
    expect(JSON.parse((hubApiFetch.mock.calls[0]?.[2] as RequestInit).body as string)).toEqual({ address: '192.168.1.42:5010' });
  });

  it('hands back the tailnet name to pair with, and says the address is not the transport', () => {
    const text = formatPoolProbeLines(probeResult()).join('\n');

    expect(text).toContain(`cihub pool pair ${PEER_A}`);
    // The one thing about this feature that would be easy and costly to misunderstand.
    expect(text).toContain('not to the address you');
  });

  it('names the port fix when nothing answered', () => {
    const text = formatPoolProbeLines(probeResult({ isCiHub: false, nodeFqdn: null, hostname: null, pairable: false, reason: 'unreachable' })).join(
      '\n',
    );

    expect(text).toContain('cihub pool probe <address>:<port>');
  });

  it('tells a Hub with no tailnet apart from one that is simply absent', () => {
    const text = formatPoolProbeLines(probeResult({ nodeFqdn: null, hostname: null, pairable: false, reason: 'no_tailnet_fqdn' })).join('\n');

    expect(text).toContain('has not joined a tailnet');
    expect(text).toContain('cihub tailscale up');
  });

  it('points an already-paired node at the peers list instead of offering to pair again', () => {
    const text = formatPoolProbeLines(probeResult({ alreadyPaired: true, pairable: false, reason: 'already_paired' })).join('\n');

    expect(text).toContain('already paired');
    expect(text).toContain('cihub pool peers');
  });

  it('sanitizes the address it echoes back', () => {
    const text = formatPoolProbeLines(probeResult({ address: '[31m192.168.1.42[0m' })).join('\n');

    expect(text).not.toContain('[31m');
  });
});

describe('hub-pool-cli requests', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  it('bounds every call with an AbortSignal, since hubApiFetch supplies none', async () => {
    hubApiFetch.mockResolvedValue({});

    await unpairPoolPeer('.env.local', 'peer-1');
    await setPoolEnabledSetting('.env.local', false);

    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/pool/peers/peer-1');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).method).toBe('DELETE');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(hubApiFetch.mock.calls[1]?.[1]).toBe('/inference/pool/settings');
    expect((hubApiFetch.mock.calls[1]?.[2] as RequestInit).body).toBe('{"poolEnabled":false}');
  });

  it('encodes the peer id into the path', async () => {
    hubApiFetch.mockResolvedValue({});
    await unpairPoolPeer('.env.local', 'a/b');
    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/pool/peers/a%2Fb');
  });
});
